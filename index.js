import Fastify from "fastify";
import twilio from "twilio";
import fs from "fs";
import OpenAI from "openai";
import { handleAcuityBooking } from "./acuity.js";

const fastify = Fastify({ logger: true });

// Load tenants
let tenants = {};
try {
  tenants = JSON.parse(fs.readFileSync("./tenants.json", "utf8"));
  console.log("📖 Loaded tenants.json with", Object.keys(tenants).length, "tenants");
} catch (err) {
  console.error("❌ Failed to load tenants.json:", err);
  process.exit(1);
}

// Env vars
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ACUITY_API_KEY,
  OPENAI_API_KEY,
  PORT = 10000,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !ACUITY_API_KEY || !OPENAI_API_KEY) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const twiml = twilio.twiml.VoiceResponse;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Load knowledge.md
let knowledgeBase = "";
try {
  knowledgeBase = fs.readFileSync("./knowledge.md", "utf8");
  console.log("📖 Loaded knowledge.md into memory");
} catch {
  console.warn("⚠️ No knowledge.md found, continuing without it.");
}

// Helper: find tenant by phone
function getTenantByPhone(phone) {
  return Object.values(tenants).find(t => t.phone_number === phone);
}

// Root endpoint
fastify.get("/", async () => {
  return { status: "ok", service: "LocSYNC Voice Agent" };
});

// Incoming call
fastify.post("/incoming-call", async (req, reply) => {
  const toNumber = req.body?.To;
  const tenant = getTenantByPhone(toNumber);

  const response = new twiml();
  if (!tenant) {
    response.say("Sorry, this number is not configured for LocSYNC.");
    response.hangup();
    return reply.type("text/xml").send(response.toString());
  }

  response.say(tenant.greeting_tts || "Thanks for calling. Please say what service you would like.");
  response.gather({
    input: "speech",
    action: "/handle-speech",
    method: "POST",
    timeout: 5,
  });

  reply.type("text/xml").send(response.toString());
});

// Handle speech
fastify.post("/handle-speech", async (req, reply) => {
  const speechResult = req.body?.SpeechResult;
  const toNumber = req.body?.To;
  const tenant = getTenantByPhone(toNumber);

  const response = new twiml();

  if (!tenant) {
    response.say("This number is not configured.");
    response.hangup();
    return reply.type("text/xml").send(response.toString());
  }

  if (speechResult) {
    console.log(`🎤 [${tenant.tenant_id}] Caller said:`, speechResult);

    // Check overrides first
    if (tenant.overrides) {
      for (const rule of tenant.overrides) {
        const regex = new RegExp(rule.match, "i");
        if (regex.test(speechResult)) {
          response.say(rule.reply);
          response.hangup();
          return reply.type("text/xml").send(response.toString());
        }
      }
    }

    // Check canonical answers
    if (tenant.canonical_answers) {
      for (const qa of tenant.canonical_answers) {
        const regex = new RegExp(qa.q, "i");
        if (regex.test(speechResult)) {
          response.say(qa.a);
          response.hangup();
          return reply.type("text/xml").send(response.toString());
        }
      }
    }

    // Try Acuity booking
    const bookingMsg = await handleAcuityBooking(speechResult);
    if (bookingMsg && !bookingMsg.includes("trouble")) {
      response.say(bookingMsg);
      response.hangup();
      return reply.type("text/xml").send(response.toString());
    }

    // Fallback: OpenAI knowledge
    try {
      const ai = await openai.chat.completions.create({
        model: tenant.model || "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a helpful assistant for ${tenant.studio_name}. Use the following knowledge base and FAQs to answer questions:\n\n${knowledgeBase}`,
          },
          { role: "user", content: speechResult },
        ],
        temperature: tenant.temperature ?? 0.7,
      });

      const answer = ai.choices[0].message.content;
      response.say(answer || "I'm sorry, I couldn’t find the answer.");
    } catch (err) {
      console.error("❌ OpenAI error:", err);
      response.say("I had trouble accessing my knowledge base. Please try again later.");
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
