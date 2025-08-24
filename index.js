import Fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import fs from "fs";
import OpenAI from "openai";
import { handleAcuityBooking } from "./acuity.js";

const fastify = Fastify({ logger: true });
await fastify.register(formbody);

// ---------------- ENV ----------------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ACUITY_USER_ID,
  ACUITY_API_KEY,
  OPENAI_API_KEY,
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

// Load per-tenant knowledge ONLY (no global fallback)
function loadKnowledgeFor(tenant) {
  try {
    if (tenant?.tenant_id) {
      const p = `./knowledge/${tenant.tenant_id}.md`;
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
  } catch {}
  // No fallback to knowledge.md by design
  return "";
}

// Optional: tenant-provided extra instructions (kept fully generic)
// You can feed a simple array of strings in tenants.json under "special_instructions": [...]
function buildSpecialInstructions(t) {
  const out = [];
  if (Array.isArray(t?.special_instructions)) {
    for (const s of t.special_instructions) {
      if (s && typeof s === "string") out.push(`- ${s}`);
    }
  }
  return out.length ? `Special Instructions:\n${out.join("\n")}` : "";
}

// Build tenant-aware VOICE prompt (parameterized only; no salon-specific assumptions)
function buildVoicePrompt(tenant, kbTextRaw) {
  const t = tenant || {};
  const services = (t.services || []).join(", ");
  const pricing = (t.pricing_notes || []).join(" | ");
  const policies = (t.policies || []).join(" | ");
  const hours = t.hours_string || "Hours not provided";
  const location = t.location || "Location not provided";
  const bookingLine = t.booking_url ? `- Booking Link: ${t.booking_url}` : null;

  // Canonical Q&A (must-say)
  const canon =
    (t.canonical_answers || [])
      .map((it, i) => `Q${i + 1}: ${it.q}\nA${i + 1}: ${it.a}`)
      .join("\n") || "(none)";

  // Hard overrides (regex → exact reply)
  const overrides =
    (t.overrides || [])
      .map((o) => `IF the user utterance matches /${o.match}/ THEN reply exactly: "${o.reply}"`)
      .join("\n");

  // Field caps
  const fileCap = Number.isFinite(t.kb_per_file_char_cap) ? t.kb_per_file_char_cap : 10000;
  const instrCap = Number.isFinite(t.instructions_char_cap) ? t.instructions_char_cap : 24000;
  const kbText = (kbTextRaw || "").slice(0, fileCap);

  const special = buildSpecialInstructions(t);

  let prompt = `
You are the virtual receptionist for "${t.studio_name}" in ${t.timezone || "America/Detroit"}.
Speak warmly and clearly like a front-desk assistant. Keep answers under 20 seconds.
Do not repeat or paraphrase the caller’s question. Answer directly and concisely.

Salon Facts (always accurate):
- Name: ${t.studio_name}
- Location: ${location}
- Hours: ${hours}
${bookingLine ? bookingLine : "" }
- Services: ${services || "(none provided)"}
- Pricing: ${pricing || "(none provided)"}
- Policies: ${policies || "(none provided)"}

${special || ""}

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
  return { status: "ok", service: "LocSync Voice Agent (multi-tenant, generic)" };
});

// Incoming call: tenant-aware greeting (from tenants.json)
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

// Handle speech: try booking, else tenant-aware OpenAI
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
      try {
        const kbText = loadKnowledgeFor(tenant);           // per-tenant only (no fallback)
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
