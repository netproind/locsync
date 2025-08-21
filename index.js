import Fastify from "fastify";
import twilio from "twilio";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { handleSquareFindBooking, handleSquareCreateBooking, handleSquareCancelBooking } from "./square.js";

// --- Load tenant knowledge (you can extend this later per tenant)
const tenant = process.env.TENANT || "default";
const knowledgePath = path.join(process.cwd(), "knowledge.md");
const knowledgeText = fs.existsSync(knowledgePath)
  ? fs.readFileSync(knowledgePath, "utf-8")
  : "No knowledge file found.";

const fastify = Fastify({ logger: true });
const VoiceResponse = twilio.twiml.VoiceResponse;

fastify.register(fastifyWebsocket);

// === Incoming Call (Twilio webhook) ===
fastify.post("/incoming-call", async (req, reply) => {
  const twiml = new VoiceResponse();
  twiml.say("Thank you for calling Loc Repair Clinic, connecting you now.");

  // Stream audio to /media-stream
  twiml.connect().stream({
    url: `wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/media-stream`
  });

  reply
    .code(200)
    .header("Content-Type", "text/xml")
    .send(twiml.toString());
});

// === Media Stream Handler (bridge Twilio <-> OpenAI) ===
fastify.get("/media-stream", { websocket: true }, (twilioConn) => {
  console.log("📞 Twilio media stream connected");

  // Connect to OpenAI Realtime API
  const openaiConn = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // --- Inject tenant-specific knowledge + Square functions ---
  openaiConn.on("open", () => {
    console.log("✅ OpenAI session started");

    const systemPrompt = `
      You are the phone assistant for ${tenant}.
      - Use the following knowledge to answer general questions:\n${knowledgeText}
      - If the user asks about appointments, use the provided Square functions.
      - Keep answers short and conversational, since this is over the phone.
    `;

    openaiConn.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: systemPrompt,
        input_audio_format: { type: "g711_ulaw", sample_rate_hz: 8000 },
        output_audio_format: { type: "g711_ulaw", sample_rate_hz: 8000 },
        tools: [
          { name: "handleSquareFindBooking", description: "Look up a customer's appointments" },
          { name: "handleSquareCreateBooking", description: "Create a new appointment" },
          { name: "handleSquareCancelBooking", description: "Cancel an appointment" }
        ]
      }
    }));
  });

  // --- Twilio -> OpenAI ---
  twilioConn.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "media" && openaiConn.readyState === WebSocket.OPEN) {
        openaiConn.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        }));
      } else if (data.event === "stop") {
        if (openaiConn.readyState === WebSocket.OPEN) {
          openaiConn.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiConn.send(JSON.stringify({ type: "response.create" }));
        }
      }
    } catch (err) {
      console.error("❌ Error parsing Twilio message:", err);
    }
  });

  // --- OpenAI -> Twilio ---
  openaiConn.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.type === "output_audio_buffer.append") {
        twilioConn.send(JSON.stringify({
          event: "media",
          media: { payload: data.audio }
        }));
      }

      if (data.type === "response.completed") {
        twilioConn.send(JSON.stringify({ event: "mark", mark: { name: "end" } }));
      }

      // Handle function calls (Square integrations)
      if (data.type === "function_call") {
        let result;
        if (data.name === "handleSquareFindBooking") {
          result = await handleSquareFindBooking(data.arguments);
        } else if (data.name === "handleSquareCreateBooking") {
          result = await handleSquareCreateBooking(data.arguments);
        } else if (data.name === "handleSquareCancelBooking") {
          result = await handleSquareCancelBooking(data.arguments);
        }

        // Send function response back to OpenAI
        if (result) {
          openaiConn.send(JSON.stringify({
            type: "function_call_result",
            call_id: data.id,
            output: result
          }));
        }
      }
    } catch (err) {
      console.error("❌ Error parsing OpenAI message:", err);
    }
  });

  // Cleanup
  twilioConn.on("close", () => {
    console.log("❌ Twilio connection closed");
    if (openaiConn.readyState === WebSocket.OPEN) openaiConn.close();
  });

  openaiConn.on("close", () => {
    console.log("❌ OpenAI connection closed");
    if (twilioConn.readyState === WebSocket.OPEN) twilioConn.close();
  });
});

// === Start Server ===
const PORT = process.env.PORT || 10000;
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server running on ${PORT}`);
});
