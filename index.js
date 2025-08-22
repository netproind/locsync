import Fastify from "fastify";
import twilio from "twilio";
import fs from "fs";
import OpenAI from "openai";
import tenants from "./tenants.json" assert { type: "json" };
import { handleAcuityBooking } from "./acuity.js";

const fastify = Fastify({ logger: true });

// Environment variables
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ACUITY_API_KEY,
  OPENAI_API_KEY,
  RENDER_EXTERNAL_HOSTNAME,
  PORT = 10000,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !ACUITY_API_KEY || !OPENAI_API_KEY) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const twiml = twilio.twiml.VoiceResponse;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Load knowledge.md into memory
let knowledgeBase = "";
try {
  knowledgeBase = fs.readFileSync("./knowledge.md", "utf8");
  console.log("📖 Loaded knowledge.md into memory");
} catch (err) {
  console.warn("⚠️ No knowledge.md found, continuing without it.");
}

// Helper: get tenant by phone number
function getTenantByNumber(phoneNumber) {
  return Object.values(tenants).find(t => t.phone_number === phoneNumber) || null;
}

// Root endpoint
fastify.get("/", async () => {
  return { status: "ok", service: "LocSYNC Voice Agent with Acuity + Knowledge + Tenants" };
});

// Twilio webhook: incoming call
fastify.post("/incoming-call", async (req, reply) => {
  const response = new twiml();

  const toNumber = req.body?.To; // Twilio sends the called number
  const tenant = getTenantByNumber(toNumber);

  if (!tenant) {
    response.say("Sorry, this number is not registered with LocSYNC.");
    response.hangup();
    reply.type("text/xml").send(response.toString());
    return;
  }

  console.log(`📞 Incoming call for tenant: ${tenant.tenant_id}`);

  response.say(tenant.greeting_tts || "Thanks for calling. Please say what service you would like to book or ask me a question.");
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
  const toNumber = req.body?.To;
  const tenant = getTenantByNumber(toNumber);

  const response = new twiml();

  if (!tenant) {
    response.say("Sorry, this number is not registered with LocSYNC.");
    response.hangup();
    reply.type("text/xml").send(response.toString());
    return;
  }

  if (speechResult) {
    console.log(`🎤 Caller said: ${speechResult} (Tenant: ${tenant.tenant_id})`);

    // Try booking first
    const bookingMsg = await handleAcuityBooking(speechResult, tenant);

    if (bookingMsg && !bookingMsg.includes("I didn’t understand")) {
      response.say(bookingMsg);
    } else {
      // Fallback: use OpenAI with tenant’s context
      try {
        const ai = await openai.chat.completions.create({
          model: tenant.model || "gpt-4o-mini",
          temperature: tenant.temperature || 0.7,
          messages: [
            { role: "system", content: `You are a helpful assistant for ${tenant.studio_name}, part of the LocSYNC brand. Use this knowledge base:\n\n${knowledgeBase}` },
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
