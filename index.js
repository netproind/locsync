import Fastify from "fastify";
import formbody from "@fastify/formbody";   // ✅ parse Twilio POST form data
import twilio from "twilio";
import fs from "fs";
import OpenAI from "openai";
import { handleAcuityBooking } from "./acuity.js";

const fastify = Fastify({ logger: true });

// ✅ Register formbody so Twilio's application/x-www-form-urlencoded works
await fastify.register(formbody);

// Environment variables (set these in Render dashboard)
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ACUITY_API_KEY,
  OPENAI_API_KEY,
  RENDER_EXTERNAL_HOSTNAME,
  PORT = 10000,
} = process.env;

if (
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER ||
  !ACUITY_API_KEY ||
  !OPENAI_API_KEY
) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const twiml = twilio.twiml.VoiceResponse;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Load tenants.json
let tenants = {};
try {
  tenants = JSON.parse(fs.readFileSync("./tenants.json", "utf8"));
  console.log(`📖 Loaded tenants.json with ${Object.keys(tenants).length} tenants`);
} catch (err) {
  console.warn("⚠️ No tenants.json found, continuing without it.");
}

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
  const callerNumber = req.body?.From;
  const response = new twiml();

  if (speechResult) {
    console.log("🎤 Caller said:", speechResult);

    // Lookup tenant by caller phone
    const tenant = tenants[callerNumber] || null;

    // Try booking first
    const bookingMsg = await handleAcuityBooking(speechResult);

    if (bookingMsg && !bookingMsg.includes("I didn’t understand")) {
      response.say(bookingMsg);
    } else {
      // Fallback: ask OpenAI to answer from knowledge.md + tenant config
      try {
        const kbContent = tenant
          ? `${knowledgeBase}\n\nTenant Info:\n${JSON.stringify(tenant, null, 2)}`
          : knowledgeBase;

        const ai = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `You are a helpful assistant for LocSync voice agent. Use the following knowledge base to answer questions:\n\n${kbContent}`,
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
