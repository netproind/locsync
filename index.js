import Fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import fs from "fs";
import OpenAI from "openai";

const fastify = Fastify({ logger: true });
await fastify.register(formbody);

// ---------------- ENV ----------------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  OPENAI_API_KEY,
  PORT = 10000,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !OPENAI_API_KEY) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const twiml = twilio.twiml.VoiceResponse;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------- TENANTS ----------------
let TENANTS = {};
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
  
  // Case 1: Direct phone number key
  if (TENANTS[toNumber]) return TENANTS[toNumber];
  if (TENANTS[normalized]) return TENANTS[normalized];
  
  // Case 2: Search by phone_number field
  for (const tenant of Object.values(TENANTS)) {
    if (tenant?.phone_number) {
      const tenantNormalized = normalizePhone(tenant.phone_number);
      if (tenantNormalized === normalized) return tenant;
    }
  }
  
  // Fallback to first tenant
  return Object.values(TENANTS)[0] || null;
}

// Bulletproof phone normalization
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

// Build voice prompt
function buildVoicePrompt(tenant, knowledgeText) {
  const t = tenant || {};
  const services = (t.services || []).join(", ");
  const hours = t.hours_string || "Please call during business hours";
  const location = t.location || "Location available upon request";

  const canonicalQA = (t.canonical_answers || [])
    .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`)
    .join("\n") || "(none)";

  const kbText = (knowledgeText || "").slice(0, 8000);

  let prompt = `You are the virtual receptionist for "${t.studio_name || 'our salon'}".

IMPORTANT: Keep responses under 15 seconds. Be warm, professional, and direct. Never spell out URLs letter by letter - just say "visit our online portal" or "check our website".

Salon Information:
- Name: ${t.studio_name || 'The Salon'}
- Location: ${location}
- Hours: ${hours}
- Services: ${services || "Hair care services"}

Canonical Q&A (use these exact responses):
${canonicalQA}

Knowledge Base:
${kbText}

Remember: Answer directly, don't spell out URLs, keep responses conversational and under 15 seconds.`;

  return prompt.slice(0, 20000);
}

// Google Sheets API integration
async function callGoogleSheetsAPI(tenant, action, params = {}) {
  if (!tenant?.sheets_web_app_url) {
    fastify.log.warn({ tenant: tenant?.tenant_id }, "No sheets_web_app_url configured");
    return { handled: false, speech: "I'm unable to access appointment information right now." };
  }

  try {
    const url = new URL(tenant.sheets_web_app_url);
    url.searchParams.set('action', action);
    
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    });

    fastify.log.info({ url: url.toString() }, "Calling Google Sheets API");

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    fastify.log.info({ data }, "Google Sheets API response");
    
    return data;
  } catch (err) {
    fastify.log.error({ err, tenant: tenant?.tenant_id, action }, "Google Sheets API error");
    return { 
      handled: false, 
      speech: "I'm having trouble accessing our appointment system. Please try again in a few minutes." 
    };
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

// Handle speech input
fastify.post("/handle-speech", async (req, reply) => {
  const speechResult = req.body?.SpeechResult?.trim() || "";
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  // Debug tenant lookup
  fastify.log.info({
    speech: speechResult,
    tenant: tenant?.tenant_id,
    hasSheetUrl: !!tenant?.sheets_web_app_url,
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

    // Check for appointment-related requests
    if (lowerSpeech.includes('appointment') || 
        lowerSpeech.includes('book') || 
        lowerSpeech.includes('schedule') || 
        lowerSpeech.includes('cancel') || 
        lowerSpeech.includes('reschedule') ||
        lowerSpeech.includes('look') ||
        lowerSpeech.includes('check') ||
        lowerSpeech.includes('find')) {
      
      fastify.log.info({ phone: fromNumber }, "Appointment request detected");
      
      const appointmentResult = await callGoogleSheetsAPI(tenant, 'appt_lookup', {
        phone: fromNumber
      });
      
      if (appointmentResult.handled) {
        response.say(appointmentResult.speech);
        handled = true;
      }
    }

    // If not handled by appointment logic, use OpenAI
    if (!handled) {
      const knowledgeText = loadKnowledgeFor(tenant);
      const systemPrompt = buildVoicePrompt(tenant, knowledgeText);

      const model = tenant?.model || "gpt-4o-mini";
      const temperature = tenant?.temperature ?? 0.7;

      const completion = await openai.chat.completions.create({
        model,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: speechResult }
        ],
        max_tokens: 100
      });

      const aiResponse = completion.choices?.[0]?.message?.content?.trim() || 
        "I'm sorry, I couldn't process that request right now.";
      
      response.say(aiResponse);
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
      
      const result = await callGoogleSheetsAPI(tenant, 'appt_lookup', { phone: fromNumber });
      response.message(result.speech || "Please call us for appointment assistance.");
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
    phone_normalized: normalizePhone(tenant.phone_number)
  };
});

fastify.get("/test-sheets/:tenantId", async (req, reply) => {
  const { tenantId } = req.params;
  const { phone, action = 'appt_lookup' } = req.query;
  
  const tenant = TENANTS[tenantId] || TENANTS[`+${tenantId}`];
  if (!tenant) {
    return { error: "Tenant not found" };
  }

  const result = await callGoogleSheetsAPI(tenant, action, { phone });
  return result;
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

fastify.get("/debug-sheets", async (req, reply) => {
  const tenant = TENANTS["yesha_locsync_v1"];
  const testUrl = tenant.sheets_web_app_url + "?action=appt_lookup&phone=3134714195";
  
  try {
    const response = await fetch(testUrl);
    const text = await response.text();
    
    return {
      url: testUrl,
      status: response.status,
      response: text,
      headers: Object.fromEntries(response.headers.entries())
    };
  } catch (err) {
    return {
      error: err.message,
      url: testUrl
    };
  }
});
