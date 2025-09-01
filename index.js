import Fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import fs from "fs";

const fastify = Fastify({ logger: true });
await fastify.register(formbody);

// ---------------- ENV ----------------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PORT = 10000,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const twiml = twilio.twiml.VoiceResponse;

// ---------------- TENANTS ----------------
let TENANTS = {};
let SHEETS_CACHE = {}; // store appointments per tenant

try {
  TENANTS = JSON.parse(fs.readFileSync("./tenants.json", "utf8"));
  fastify.log.info("✅ Loaded tenants.json");
} catch (e) {
  fastify.log.warn("⚠️ No tenants.json found. Using defaults.");
}

// Resolve tenant from Twilio "To" number
function getTenantByToNumber(toNumber) {
  if (!toNumber) return null;
  const normalized = normalizePhone(toNumber);

  if (TENANTS[toNumber]) return TENANTS[toNumber];
  if (TENANTS[normalized]) return TENANTS[normalized];

  for (const tenant of Object.values(TENANTS)) {
    if (tenant?.phone_number) {
      const tenantNormalized = normalizePhone(tenant.phone_number);
      if (tenantNormalized === normalized) return tenant;
    }
  }
  return Object.values(TENANTS)[0] || null;
}

// Normalize phone
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-10);
}

// Load tenant knowledge
function loadKnowledgeFor(tenant) {
  try {
    if (tenant?.tenant_id) {
      const path = `./knowledge/${tenant.tenant_id}.md`;
      if (fs.existsSync(path)) {
        return fs.readFileSync(path, "utf8");
      }
    }
    if (fs.existsSync("./knowledge.md")) {
      return fs.readFileSync("./knowledge.md", "utf8");
    }
  } catch (err) {
    fastify.log.warn({ err }, "Error loading knowledge");
  }
  return "";
}

// Async preload Sheets data
async function preloadSheetsData(tenant) {
  if (!tenant?.sheets_web_app_url) return;

  try {
    const url = new URL(tenant.sheets_web_app_url);
    url.searchParams.set('action', 'appt_lookup_all');

    const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const data = await response.json();
    SHEETS_CACHE[tenant.tenant_id] = data;
    fastify.log.info({ tenant: tenant.tenant_id, count: data.length }, "✅ Preloaded fresh Sheets data");
  } catch (err) {
    fastify.log.error({ err, tenant: tenant?.tenant_id }, "❌ Failed to preload sheets");
  }
}

// ---------------- ROUTES ----------------
fastify.get("/", async () => {
  return {
    status: "ok",
    service: "LocSync Voice Agent",
    tenants: Object.keys(TENANTS).length
  };
});

fastify.get("/health", async () => {
  return { status: "healthy", timestamp: new Date().toISOString() };
});

// Incoming call handler
fastify.post("/incoming-call", async (req, reply) => {
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({
    to: toNumber,
    from: fromNumber,
    tenant: tenant?.tenant_id
  }, "Incoming call");

  // Fire preload in background (non-blocking)
  preloadSheetsData(tenant);

  const response = new twiml();
  const greeting = tenant?.greeting_tts ||
    `Thank you for calling ${tenant?.studio_name || "our salon"}. How can I help you today?`;

  response.say(greeting);
  response.gather({
    input: "speech",
    action: "/handle-speech",
    method: "POST",
    timeout: 8,
    speechTimeout: "auto"
  });

  reply.type("text/xml").send(response.toString());
});

// Handle speech input (STRICT MODE - no AI fallback)
fastify.post("/handle-speech", async (req, reply) => {
  const speechResult = req.body?.SpeechResult?.trim() || "";
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({
    speech: speechResult,
    tenant: tenant?.tenant_id,
    from: fromNumber
  }, "Processing speech");

  const response = new twiml();

  if (!speechResult) {
    response.say("I didn't catch that. Please call back and speak clearly.");
    response.hangup();
    reply.type("text/xml").send(response.toString());
    return;
  }

  try {
    const lowerSpeech = speechResult.toLowerCase();
    let handled = false;

    // --- Tier 1: Appointment requests from cache
    if (/\b(appointment|book|schedule|cancel|reschedule|check|find|look)\b/.test(lowerSpeech)) {
      const tenantId = tenant?.tenant_id;
      const phoneClean = fromNumber.replace(/\D/g, '').slice(-10);

      const appts = SHEETS_CACHE[tenantId] || null;

      if (!appts) {
        response.say("I’m still syncing appointment data. Please ask again in a moment.");
      } else {
        const found = appts.filter(row => row.phone === phoneClean);
        if (found.length > 0) {
          response.say(`You have ${found.length} appointment${found.length > 1 ? "s" : ""} on file.`);
        } else {
          response.say("I couldn’t find any appointments. Please check our booking portal.");
        }
      }
      handled = true;
    }

    // --- Tier 2: Canonical Q&A
    if (!handled && tenant?.canonical_answers) {
      for (const qa of tenant.canonical_answers) {
        const regex = new RegExp(qa.q, "i");
        if (regex.test(lowerSpeech)) {
          response.say(qa.a);
          handled = true;
          break;
        }
      }
    }

    // --- Tier 3: Knowledge.md keyword lookup
    if (!handled) {
      const knowledgeText = loadKnowledgeFor(tenant).toLowerCase();
      const words = lowerSpeech.split(/\s+/);
      let matched = false;

      for (const word of words) {
        if (word.length > 3 && knowledgeText.includes(word)) {
          response.say("Please visit our booking portal for more details.");
          matched = true;
          handled = true;
          break;
        }
      }
    }

    // --- Tier 4: Hard fallback
    if (!handled) {
      response.say("Please visit our booking portal for more details.");
    }

    // Continue conversation
    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 6
    });
    response.say("Anything else I can help with?");

  } catch (err) {
    fastify.log.error({ err }, "Error processing speech");
    response.say("I'm having technical difficulties. Please try calling back.");
    response.hangup();
  }

  reply.type("text/xml").send(response.toString());
});

// SMS handler
fastify.post("/incoming-sms", async (req, reply) => {
  const body = req.body?.Body?.trim() || "";
  const fromNumber = (req.body?.From || "").trim();
  const toNumber = (req.body?.To || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({ body, from: fromNumber, tenant: tenant?.tenant_id }, "Incoming SMS");

  const response = new twilio.twiml.MessagingResponse();

  try {
    if (body.toLowerCase().includes('appointment') ||
        body.toLowerCase().includes('book') ||
        body.toLowerCase().includes('cancel')) {

      const tenantId = tenant?.tenant_id;
      const phoneClean = fromNumber.replace(/\D/g, '').slice(-10);

      const appts = SHEETS_CACHE[tenantId] || null;

      if (!appts) {
        response.message("I’m still syncing appointment data. Please try again in a few minutes.");
      } else {
        const found = appts.filter(row => row.phone === phoneClean);
        if (found.length > 0) {
          response.message(`You have ${found.length} appointment${found.length > 1 ? "s" : ""} on file.`);
        } else {
          response.message("No appointments found. Please check our booking portal.");
        }
      }
    } else {
      response.message("Thanks for texting! Please call us or visit our online portal for assistance.");
    }
  } catch (err) {
    fastify.log.error({ err }, "SMS processing error");
    response.message("Sorry, I'm having technical issues. Please call us directly.");
  }

  reply.type("text/xml").send(response.toString());
});

// Test endpoints
fastify.get("/test/:tenantId", async (req, reply) => {
  const { tenantId } = req.params;
  const tenant = TENANTS[tenantId] || TENANTS[`+${tenantId}`];

  if (!tenant) {
    return { error: "Tenant not found", available: Object.keys(TENANTS) };
  }

  return {
    tenant_id: tenant.tenant_id,
    has_sheet_url: !!tenant.sheets_web_app_url,
    phone_normalized: normalizePhone(tenant.phone_number),
    cached_appts: SHEETS_CACHE[tenant.tenant_id]?.length || 0
  };
});

fastify.get("/debug-sheets", async (req, reply) => {
  const tenant = TENANTS["yesha_locsync_v1"];
  const testUrl = tenant.sheets_web_app_url + "?action=appt_lookup&phone=3134714195";
  
  try {
    const response = await fetch(testUrl);
    const text = await response.text();
    
    return {
      url: testUrl,
      status: response.status,
      response: text
    };
  } catch (err) {
    return {
      error: err.message,
      url: testUrl
    };
  }
});

// ---------------- START SERVER ----------------
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 LocSync Voice Bot running on ${address}`);
  console.log(`📞 Configured tenants: ${Object.keys(TENANTS).join(", ")}`);
});
