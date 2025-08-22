import Fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import fs from "fs";
import OpenAI from "openai";
import { handleAcuityBooking } from "./acuity.js";

const fastify = Fastify({ logger: true });

// Register parser so Twilio webhooks (x-www-form-urlencoded) are accepted
await fastify.register(formbody);

// Environment variables (set these in Render dashboard)
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ACUITY_USER_ID,
  ACUITY_API_KEY,
  OPENAI_API_KEY,
  RENDER_EXTERNAL_HOSTNAME,
  PORT = 10000,
} = process.env;

if (
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !ACUITY_USER_ID ||
  !ACUITY_API_KEY ||
  !OPENAI_API_KEY
) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const twiml = twilio.twiml.VoiceResponse;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Load knowledge.md into memory at startup
let knowledgeBase = "";
try {
  knowledgeBase = fs.readFileSync("./knowledge.md", "utf8");
  console.log("📖 Loaded knowledge.md into memory");
} catch (err) {
  console.warn("⚠️ No knowledge.md found, continuing without it.");
}

// Root endpoint
fastify.get("/", async () => {
  return { status: "ok", service: "LocSync Voice Agent with Acuity + Knowledge" };
});

// Twilio webhook: incoming call
fastify.post("/incoming-call", async (req, reply) => {
  const response = new twiml();

  response.say(
    "Thank you for calling Loc Repair Clinic. Please say what service you would like to book or ask me a question."
  );
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

    // Try booking first
    const bookingMsg = await handleAcuityBooking(speechResult);

    if (bookingMsg && !bookingMsg.includes("I didn’t understand")) {
      response.say(bookingMsg);
    } else {
      // Fallback: ask OpenAI to answer from knowledge.md
      try {
        const ai = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a helpful assistant for Loc Repair Clinic. Use the following knowledge base to answer questions:\n\n${knowledgeBase}`,
            },
            { role: "user", content: speechResult },
          ],
        });

        const answer = ai.choices[0].message.content;
        response.say(answer || "I'm sorry, I couldn’t find the answer.");
      } catch (err) {
        console.error("❌ OpenAI error:", err);
        response.say("I had trouble accessing my knowledge base. Please try again later.");
      }
    }
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
