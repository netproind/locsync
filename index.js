import Fastify from "fastify";
import formBody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import fs from "fs";
import { marked } from "marked";
import twilio from "twilio";

import { getAppointments, createAppointment, cancelAppointment } from "./acuity.js";

const fastify = Fastify({ logger: true });
await fastify.register(formBody);
await fastify.register(websocket);

const VoiceResponse = twilio.twiml.VoiceResponse;
const PORT = process.env.PORT || 10000;

// Load knowledge.md
const knowledge = fs.readFileSync("./knowledge.md", "utf-8");
const knowledgeText = marked.parse(knowledge);

// Health check
fastify.get("/", async () => {
  return { status: "ok" };
});

// Twilio webhook: incoming call
fastify.post("/incoming-call", async (req, reply) => {
  const twiml = new VoiceResponse();
  twiml.say("Thank you for calling Loc Repair Clinic, connecting you now.");
  twiml.connect().stream({
    url: `wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/media-stream`,
  });

  reply.type("text/xml").send(twiml.toString());
});

// WebSocket for media stream
fastify.get("/media-stream", { websocket: true }, (conn) => {
  console.log("📞 Twilio media stream connected");
  conn.socket.on("message", (msg) => {
    console.log("Received audio chunk:", msg.toString().length);
  });
  conn.socket.on("close", () => {
    console.log("🔌 Twilio stream closed");
  });
});

// Acuity routes
fastify.get("/acuity/find", async () => {
  return await getAppointments();
});

fastify.post("/acuity/create", async (req) => {
  return await createAppointment(req.body);
});

fastify.post("/acuity/cancel", async (req) => {
  const { appointmentId } = req.body;
  return await cancelAppointment(appointmentId);
});

// Knowledge Q&A endpoint
fastify.post("/ask", async (req) => {
  const { question } = req.body;
  // Simple search in knowledge text
  const answer = knowledgeText.includes(question)
    ? "Yes, I found something relevant: " + question
    : "Sorry, I couldn't find that in my knowledge base.";
  return { answer };
});

// Start server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server running on ${PORT}`);
});
