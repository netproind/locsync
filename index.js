import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket } from "ws";
import dotenv from "dotenv";

dotenv.config();

const app = Fastify({ logger: true });
app.register(fastifyWebsocket);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in environment");
}

// --- Root route ---
app.get("/", async (req, reply) => {
  return { status: "ok", message: "Locsync voice agent server is live" };
});

// --- Incoming call webhook from Twilio ---
app.post("/incoming-call", async (req, reply) => {
  const twiml = `
    <Response>
      <Say voice="alice">Hello, you are connected to the appointment assistant. Please ask your question after the beep.</Say>
      <Connect>
        <Stream url="wss://${req.hostname}/media-stream" />
      </Connect>
    </Response>
  `;
  reply.type("text/xml").send(twiml);
});

// --- Twilio Media Stream WebSocket ---
app.get("/media-stream", { websocket: true }, (conn, req) => {
  console.log("📞 Twilio media stream connected");

  // Create Realtime connection to OpenAI
  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01", {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWs.on("open", () => {
    console.log("✅ Connected to OpenAI Realtime API");
  });

  // --- Incoming Twilio audio -> send to OpenAI ---
  conn.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "media") {
        // forward base64 PCM16 audio to OpenAI
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload,
        }));
      } else if (data.event === "start") {
        console.log("▶️ Call started");
      } else if (data.event === "stop") {
        console.log("⏹️ Call stopped");
      }
    } catch (err) {
      console.error("⚠️ Error parsing Twilio message:", err);
    }
  });

  // --- OpenAI -> Twilio (AI response audio) ---
  openaiWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === "output_audio_buffer.append") {
        conn.send(JSON.stringify({
          event: "media",
          media: { payload: data.audio }, // base64 PCM16 back to Twilio
        }));
      } else if (data.type === "output_audio_buffer.commit") {
        conn.send(JSON.stringify({ event: "mark", mark: { name: "response-end" } }));
      }
    } catch (err) {
      console.error("⚠️ Error parsing OpenAI message:", err);
    }
  });

  // Close cleanup
  conn.on("close", () => {
    console.log("❌ Twilio media stream closed");
    openaiWs.close();
  });

  openaiWs.on("close", () => {
    console.log("❌ OpenAI Realtime connection closed");
  });
});

// --- Start server ---
const port = process.env.PORT || 10000;
app.listen({ port, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server running on ${port}`);
});
