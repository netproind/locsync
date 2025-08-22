import Fastify from "fastify";
import formBody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import fs from "fs";
import twilio from "twilio";

import { getAppointments, createAppointment, cancelAppointment } from "./acuity.js";

const fastify = Fastify({ logger: true });
await fastify.register(formBody);
await fastify.register(websocket);

const VoiceResponse = twilio.twiml.VoiceResponse;
const PORT = process.env.PORT || 10000;

// Load knowledge.md into memory
const knowledge = fs.readFileSync("./knowledge.md", "utf-8");

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
    const gather = twiml.gather({
      input: "speech",
      action: "/process-schedule",
      method: "POST",
      timeout: 5
    });
    gather.say("Would you like to check, create, or cancel an appointment?");
  } else {
    // Simple knowledge lookup
    const found = knowledge.toLowerCase().includes(speechResult);
    const answer = found
      ? "Here is what I found in my knowledge base about that."
      : "Sorry, I could not find that in my knowledge base.";

    twiml.say(answer);
    twiml.hangup();
  }

  reply.type("text/xml").send(twiml.toString());
});

// Process schedule request
fastify.post("/process-schedule", async (req, reply) => {
  const speechResult = req.body.SpeechResult?.toLowerCase() || "";
  const twiml = new VoiceResponse();

  if (speechResult.includes("check")) {
    const appts = await getAppointments();
    if (appts && appts.length > 0) {
      twiml.say(`You have ${appts.length} appointments scheduled.`);
    } else {
      twiml.say("I could not find any appointments scheduled.");
    }
  } else if (speechResult.includes("create")) {
    // Placeholder — later we’ll expand with real input
    const appt = await createAppointment({
      datetime: new Date().toISOString(),
      name: "Caller",
      email: "caller@example.com"
    });
    twiml.say("Your appointment has been created.");
  } else if (speechResult.includes("cancel")) {
    // Placeholder — later expand with real input
    await cancelAppointment("12345");
    twiml.say("Your appointment has been canceled.");
  } else {
    twiml.say("Sorry, I didn’t understand. Please say check, create, or cancel.");
    twiml.redirect("/incoming-call");
  }

  twiml.hangup();
  reply.type("text/xml").send(twiml.toString());
});

// WebSocket for media stream (optional debugging)
fastify.get("/media-stream", { websocket: true }, (conn) => {
  console.log("📞 Twilio media stream connected");
  conn.socket.on("message", (msg) => {
    console.log("Received audio chunk:", msg.toString().length);
  });
  conn.socket.on("close", () => {
    console.log("🔌 Twilio stream closed");
  });
});

// Start server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server running on ${PORT}`);
});
