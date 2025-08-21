// index.js
import fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyFormbody from "@fastify/formbody";
import twilio from "twilio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { handleSquareFindBooking } from "./square.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = fastify({ logger: true });

app.register(fastifyWebsocket);
app.register(fastifyFormbody);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Load tenants
const tenantsPath = path.join(__dirname, "tenants.json");
const tenants = JSON.parse(fs.readFileSync(tenantsPath, "utf-8"));

// --- Incoming call webhook ---
app.post("/incoming-call", async (req, reply) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Thanks for calling the Loc Repair Clinic. Connecting you now.");
  twiml.connect().stream({ url: `wss://${req.hostname}/media-stream` });

  reply.type("text/xml").send(twiml.toString());
});

// --- Media stream ---
app.get("/media-stream", { websocket: true }, (connection) => {
  console.log("📞 Twilio media stream connected");
  connection.socket.on("message", (msg) => {
    console.log("Media event:", msg.toString());
  });
  connection.socket.on("close", () => {
    console.log("❌ Twilio media stream disconnected");
  });
});

// --- Square booking endpoint ---
app.post("/find-booking", async (req, reply) => {
  try {
    const { phone } = req.body;
    const booking = await handleSquareFindBooking(phone);
    reply.send({ success: true, booking });
  } catch (err) {
    console.error("Error fetching booking:", err);
    reply.status(500).send({ success: false, error: err.message });
  }
});

// --- Start server ---
const port = process.env.PORT || 10000;
app.listen({ port, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server running on ${port}`);
});
