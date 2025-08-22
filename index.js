import Fastify from "fastify";
import twilio from "twilio";
import { handleAcuityBooking } from "./acuity.js";

const fastify = Fastify({ logger: true });

// Environment variables (set these in Render dashboard)
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ACUITY_API_KEY,
  RENDER_EXTERNAL_HOSTNAME,
  PORT = 10000,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !ACUITY_API_KEY) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const twiml = twilio.twiml.VoiceResponse;

// Root endpoint
fastify.get("/", async () => {
  return { status: "ok", service: "LocSync Voice Agent with Acuity" };
});

// Twilio webhook: incoming call
fastify.post("/incoming-call", async (req, reply) => {
  const response = new twiml();

  response.say("Thank you for calling Loc Repair Clinic. Please say what service you would like to book.");
  response.gather({
    input: "speech",
    action: "/handle-speech",
    method: "POST",
    timeout: 5,
  });

  reply.type("text/xml").send(response.toString());
});

// Handle speech from caller
fastify.post("/handle-speech", async (req, reply) => {
  const speechResult = req.body?.SpeechResult;
  const response = new twiml();

  if (speechResult) {
    console.log("🎤 Caller said:", speechResult);
    const bookingMsg = await handleAcuityBooking(speechResult);
    response.say(bookingMsg);
  } else {
    response.say("I didn’t catch that. Please try again later.");
  }

  response.hangup();
  reply.type("text/xml").send(response.toString());
});

// Start server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server running on ${address}`);
});
