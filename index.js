import Fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import fs from "fs";
import OpenAI from "openai";
import { handleAcuityBooking } from "./acuity.js";

const fastify = Fastify({ logger: true });

// Accept Twilio webhooks (x-www-form-urlencoded)
await fastify.register(formbody);

// ---------------- ENV ----------------
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

// ---------------- TENANTS ----------------
// Load tenants.json (supports being keyed by tenant_id with phone_number inside)
let TENANTS = {};
try {
  TENANTS = JSON.parse(fs.readFileSync("./tenants.json", "utf8"));
  fastify.log.info("Loaded tenants.json");
} catch (e) {
  fastify.log.warn("No tenants.json found. Using defaults.");
  TENANTS = {};
}

// Resolve tenant from Twilio "To" number (handles both styles)
function getTenantByToNumber(toNumber) {
  if (!toNumber) return null;

  // Case 1: tenants keyed by phone number (E.164)
  if (TENANTS[toNumber]) return TENANTS[toNumber];

  // Case 2: tenants keyed by tenant_id with phone_number field
  for (const key of Object.keys(TENANTS)) {
    const t = TENANTS[key];
    if (t && t.phone_number && t.phone_number.trim() === toNumber.trim()) return t;
  }

  // Fallback
  return Object.values(TENANTS)[0] || null;
}

// Load per-tenant knowledge if available, else fallback to global knowledge.md
function loadKnowledgeFor(tenant) {
  try {
    if (tenant?.tenant_id) {
      const p = `./knowledge/${tenant.tenant_id}.md`;
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
  } catch {}
  try {
    return fs.readFileSync("./knowledge.md", "utf8");
  } catch {
    return "";
  }
}

// Build tenant-aware VOICE prompt (includes canonical answers + overrides + caps)
function buildVoicePrompt(tenant, kbTextRaw) {
  const t = tenant || {};
  const services = (t.services || []).join(", ");
  const pricing = (t.pricing_notes || []).join(" | ");
  const policies = (t.policies || []).join(" | ");

  const canon =
    (t.canonical_answers || [])
      .map((it, i) => `Q${i + 1}: ${it.q}\nA${i + 1}: ${it.a}`)
      .join("\n") || "(none)";

  const overrides =
    (t.overrides || [])
      .map((o) => `IF the user utterance matches /${o.match}/ THEN reply exactly: "${o.reply}"`)
      .join("\n");

  const fileCap = Number.isFinite(t.kb_per_file_char_cap) ? t.kb_per_file_char_cap : 10000;
  const instrCap = Number.isFinite(t.instructions_char_cap) ? t.instructions_char_cap : 24000;

  const kbText = (kbTextRaw || "").slice(0, fileCap);

  let prompt = `
You are the virtual receptionist for "${t.studio_name}" in ${t.timezone || "America/Detroit"}.
Answer as a helpful, professional, and concise salon assistant.

Priorities:
1. Always ground your answers in the salon’s official information below.
2. Keep answers short (3–5 sentences max).
3. If unsure, ask a clarifying question or guide them to book a consultation using the Acuity consultation link if they want an in-person consultation OR direct them to the service portal for a personalized quote.
4. Never make up prices, services, or policies.

Salon Facts (always accurate):
- Name: ${t.studio_name}
- Location: ${t.location || "Inside U Natural Hair, Suite 9; parking in rear lot"}
- Hours: ${t.hours_string || "Sun–Fri, 10 AM – 6 PM Eastern"}
- Booking Link: ${t.booking_url}
- Services: ${services}
- Pricing: ${pricing}
- Policies: ${policies}

Special Instructions:
- If asked about walk-ins, always reply: "We serve by appointment only at this time. For future dates, please start at ${t.booking_url} and enter the service portal."
- If asked for medical/scalp issues, say: "I can’t provide medical advice. Please consult a dermatologist."
- Always offer the service portal to new clients for quotes, pricing, and booking when relevant.
- New clients cannot book without a quote because they must first go through the service portal; do not give out direct Acuity Scheduling links unless the user says they already received a quote.
- If a user is a return client and knows their recurring service, that user can be offered a booking link to book.

Canonical Q&A (use verbatim where applicable):
${canon}

${overrides ? "HARD OVERRIDES (highest priority):\n" + overrides + "\n" : ""}

Knowledge Base (preferred over generic info):
${kbText || "(none)"}
`.trim();

  if (prompt.length > instrCap) prompt = prompt.slice(0, instrCap);
  return prompt;
}

// ---------------- ROUTES ----------------
fastify.get("/", async () => {
  return { status: "ok", service: "LocSync Voice Agent with Acuity + Knowledge (tenant-aware)" };
});

// Twilio webhook: incoming call (tenant-aware greeting)
fastify.post("/incoming-call", async (req, reply) => {
  const toNumber = (req.body?.To || "").trim();
  const tenant = getTenantByToNumber(toNumber) || {};

  const response = new twiml();
  const greeting = tenant.greeting_tts
    ? tenant.greeting_tts
    : `Thank you for calling ${tenant.studio_name || "the salon"}. Please say what service you would like to book or ask me a question.`;

  response.say(greeting);
  response.gather({
    input: "speech",
    action: "/handle-speech",
    method: "POST",
    timeout: 5,
  });

  reply.type("text/xml").send(response.toString());
});

// Handle speech from caller (tenant-aware prompt + model/temperature)
fastify.post("/handle-speech", async (req, reply) => {
  const speechResult = req.body?.SpeechResult;
  const toNumber = (req.body?.To || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  const response = new twiml();

  if (speechResult) {
    fastify.log.info({ said: speechResult, tenant: tenant?.tenant_id, to: toNumber }, "Caller said");

    // Try booking first (your existing logic)
    const bookingMsg = await handleAcuityBooking(speechResult);
    if (bookingMsg && !bookingMsg.includes("I didn’t understand")) {
      response.say(bookingMsg);
    } else {
      // Fallback: OpenAI answer from tenant-aware prompt + per-tenant knowledge
      try {
        const kbText = loadKnowledgeFor(tenant);
        const systemPrompt = buildVoicePrompt(tenant, kbText);

        const model = tenant?.model || "gpt-4o-mini";
        const temperature = Number.isFinite(tenant?.temperature) ? tenant.temperature : 0.5;

        const ai = await openai.chat.completions.create({
          model,
          temperature,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: speechResult },
          ],
        });

        const answer = ai.choices?.[0]?.message?.content?.trim();
        response.say(answer || "I'm sorry, I couldn’t find the answer.");
      } catch (err) {
        fastify.log.error({ err }, "OpenAI error");
        response.say("I had trouble accessing my knowledge. Please try again later.");
      }
    }
  } else {
    response.say("I didn’t catch that. Please try again later.");
  }

  response.hangup();
  reply.type("text/xml").send(response.toString());
});

// ---------------- START ----------------
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server running on ${address}`);
});
