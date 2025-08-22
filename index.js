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

// Load knowledge.md into memory
const knowledge = fs.readFileSync("./knowledge.md", "utf-8");
const knowledgeText = marked.parse(knowledge);

// Health check
fastify.get("/", async () => {
  return { status: "ok" };
});

// Twilio webhook: incoming call
fastify.post("/incoming-call", async (req, reply) => {
  const twiml = new VoiceResponse();

  twiml.say("Thank you for calling the Loc Repair Clinic.");
  const gather = twiml.gather({
    input: "speech",
    action: "/process-speech",
    method: "POST",
    timeout: 5
  });
  gather.say("You can ask a question about our services or say schedule to manage an appointment.");

  reply.type("text/xml").send(twiml.toString());
});

// Process speech input
fastify.post("/process-speech", async (req, reply) => {
  const speechResult = req.body.SpeechResult?.toLowerCase() || "";
  const twiml = new VoiceResponse();

  if (speechResult.includes("schedule")) {
    twiml.say("Okay, would you like to create, cancel, or check an appointment?");
    twiml.redirect("/incoming-call"); // loop back for now
  } else {
    // Simple knowledge lookup
    const answer = knowledgeText.includes(speechResult)
      ? "Here is what I found: " + speechResult
      : "Sorry, I could not find that in my knowledge base.";

    twiml.say(answer);
    twiml.hangup();
  }

  reply.type("text/xml").send(twiml.toString());
});

// WebSocket for media stream (not strictly required with Gather)
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

// Knowledge Q&A endpoint (for testing via REST)
fastify.post("/ask", async (req) => {
  const { question } = req.body;
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
