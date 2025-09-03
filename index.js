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
  AIRTABLE_PAT,
  PORT = 10000,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !OPENAI_API_KEY || !AIRTABLE_PAT) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const twiml = twilio.twiml.VoiceResponse;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------- ENHANCED TENANT LOADING ----------------
let TENANTS = {};
let TENANT_DETAILS = new Map(); // Cache for detailed tenant info

try {
  TENANTS = JSON.parse(fs.readFileSync("./tenants.json", "utf8"));
  fastify.log.info("✅ Loaded tenants registry");
} catch (e) {
  fastify.log.warn("⚠️ No tenants.json found. Using defaults.");
}

// Bulletproof phone normalization
function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-10);
}

// Load detailed tenant configuration
function loadTenantDetails(tenantId) {
  if (TENANT_DETAILS.has(tenantId)) {
    return TENANT_DETAILS.get(tenantId);
  }

  try {
    const detailsPath = `./tenants/${tenantId}/config.json`;
    if (fs.existsSync(detailsPath)) {
      const details = JSON.parse(fs.readFileSync(detailsPath, "utf8"));
      TENANT_DETAILS.set(tenantId, details);
      return details;
    }
  } catch (err) {
    fastify.log.warn({ err, tenantId }, "Error loading tenant details");
  }
  
  return {};
}

// Enhanced tenant resolver with detailed config loading
function getTenantByToNumber(toNumber) {
  if (!toNumber) return null;

  const normalized = normalizePhone(toNumber);
  let baseTenant = null;
  
  // Find base tenant from registry
  if (TENANTS[toNumber]) baseTenant = TENANTS[toNumber];
  else if (TENANTS[normalized]) baseTenant = TENANTS[normalized];
  else {
    for (const tenant of Object.values(TENANTS)) {
      if (tenant?.phone_number) {
        const tenantNormalized = normalizePhone(tenant.phone_number);
        if (tenantNormalized === normalized) {
          baseTenant = tenant;
          break;
        }
      }
    }
  }
  
  if (!baseTenant) {
    baseTenant = Object.values(TENANTS)[0] || null;
  }
  
  if (baseTenant?.tenant_id) {
    // Merge base config with detailed config
    const details = loadTenantDetails(baseTenant.tenant_id);
    return { ...baseTenant, ...details };
  }
  
  return baseTenant;
}

// Load tenant knowledge
function loadKnowledgeFor(tenant) {
  try {
    // Try tenant-specific knowledge first
    if (tenant?.tenant_id) {
      const tenantKnowledgePath = `./tenants/${tenant.tenant_id}/knowledge.md`;
      if (fs.existsSync(tenantKnowledgePath)) {
        const tenantKnowledge = fs.readFileSync(tenantKnowledgePath, "utf8");
        
        // Also load universal knowledge
        if (fs.existsSync("./knowledge.md")) {
          const universalKnowledge = fs.readFileSync("./knowledge.md", "utf8");
          return universalKnowledge + "\n\n" + tenantKnowledge;
        }
        return tenantKnowledge;
      }
    }
    
    // Fallback to universal knowledge only
    if (fs.existsSync("./knowledge.md")) {
      return fs.readFileSync("./knowledge.md", "utf8");
    }
  } catch (err) {
    fastify.log.warn({ err }, "Error loading knowledge");
  }
  return "";
}

// Enhanced voice prompt builder with detailed tenant data
function buildVoicePrompt(tenant, knowledgeText) {
  const t = tenant || {};
  
  // Core info (always available)
  const services = (t.services?.primary || t.services || []).join(", ");
  const hours = t.hours?.hours_string || t.hours_string || "Please call during business hours";
  
  // Detailed info from tenant details file
  const loctician = t.loctician_name || "our stylist";
  const experience = t.experience_years ? `${t.experience_years} years experience` : "";
  const specialties = (t.services?.specialties || t.specialties || []).join(", ");
  
  // Contact info
  const website = t.contact?.website || t.website || "";
  const instagram = t.contact?.instagram_handle || t.instagram_handle || "";
  const address = t.address ? `Located at ${t.address}` : "";
  
  // Booking and policies
  const bookingUrl = t.booking?.main_url || t.booking_url || "our online booking system";
  const depositInfo = t.policies?.deposits ? "Deposits required for appointments" : "Deposits may be required";
  const cancellationPolicy = t.policies?.cancellation ? "Please check our cancellation policy" : "Please call to cancel";
  
  // Canonical answers
  const canonicalQA = (t.canonical_answers || [])
    .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`)
    .join("\n") || "(none)";
  
  // Build comprehensive but concise prompt
  let prompt = `You are the virtual receptionist for "${t.studio_name || 'our salon'}" with ${loctician}${experience ? ` (${experience})` : ""}.

CRITICAL: Keep responses under 15 seconds. Never spell out URLs - just say "visit our website" or "check our portal".

Salon Information:
- Name: ${t.studio_name || 'The Salon'}
- Loctician: ${loctician}${experience ? ` - ${experience}` : ""}
- Hours: ${hours}
- Services: ${services || "Hair care services"}
${specialties ? `- Specialties: ${specialties}` : ""}
${address}

Booking & Policies:
- Booking: ${bookingUrl}
- Deposits: ${depositInfo}
- Cancellations: ${cancellationPolicy}

${website ? `Website: ${website}` : ""}
${instagram ? `Instagram: ${instagram}` : ""}

Canonical Q&A (use these exact responses):
${canonicalQA}

Knowledge Base:
${(knowledgeText || "").slice(0, 8000)}

Remember: Be conversational, direct, and never spell out web addresses.`;

  return prompt.slice(0, 15000);
}

// Airtable API integration
async function callAirtableAPI(tenant, action, params = {}) {
  if (!tenant?.airtable_base_id || !tenant?.airtable_table_name) {
    fastify.log.warn({ tenant: tenant?.tenant_id }, "Missing Airtable configuration");
    return { handled: false, speech: "I can't access appointment information right now." };
  }

  try {
    const baseUrl = `https://api.airtable.com/v0/${tenant.airtable_base_id}/${tenant.airtable_table_name}`;
    let url = baseUrl;
    
    if (action === 'lookup_appointments' && params.phone) {
      const phoneNorm = normalizePhone(params.phone);
      url += `?filterByFormula=SEARCH("${phoneNorm}",{client_phone})`;
    }

    fastify.log.info({ url }, "Calling Airtable API");

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_PAT}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Airtable API error: ${response.status}`);
    }

    const data = await response.json();
    fastify.log.info({ recordCount: data.records?.length }, "Airtable response");

    if (action === 'lookup_appointments') {
      return processAppointmentLookup(data.records || [], params.phone, tenant);
    }

    return { handled: true, speech: "Request processed", data };

  } catch (err) {
    fastify.log.error({ err, action }, "Airtable API error");
    return { 
      handled: false, 
      speech: "I'm having trouble accessing appointments. Please try again in a moment." 
    };
  }
}

// Process appointment lookup results - TENANT-AWARE
function processAppointmentLookup(records, searchPhone, tenant) {
  const bookingUrl = tenant?.booking?.main_url || tenant?.booking_url || "our online booking system";
  
  if (records.length === 0) {
    return {
      handled: true,
      speech: `I don't see any appointments under your number. Would you like to book online at our portal?`,
      data: { appointments: [] }
    };
  }

  const appointments = records.map(record => ({
    service: record.fields.service || 'Service',
    date: record.fields.start_iso || record.fields.date,
    status: record.fields.status || 'scheduled',
    client_name: record.fields.client_first || 'Client'
  }));

  // Filter for upcoming appointments
  const upcoming = appointments.filter(apt => {
    if (!apt.date) return true;
    try {
      return new Date(apt.date) >= new Date();
    } catch {
      return true;
    }
  });

  if (upcoming.length === 0) {
    return {
      handled: true,
      speech: `I don't see any upcoming appointments. Would you like to schedule a new one at our portal?`,
      data: { appointments }
    };
  }

  const next = upcoming[0];
  const speech = upcoming.length === 1 
    ? `You have an appointment for ${next.service}. Would you like to manage it?`
    : `You have ${upcoming.length} appointments. Your next is for ${next.service}. Need to make changes?`;

  return {
    handled: true,
    speech,
    data: { appointments: upcoming }
  };
}

// ---------------- ROUTES ----------------
fastify.get("/", async () => {
  return { 
    status: "ok", 
    service: "LocSync Voice Agent - Multi-Tenant",
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

  fastify.log.info({ to: toNumber, from: fromNumber, tenant: tenant?.tenant_id }, "Incoming call");

  const response = new twiml();
  const greeting = tenant?.voice_config?.greeting_tts || tenant?.greeting_tts || 
    `Thank you for calling ${tenant?.studio_name || "our salon"}. How can I help you?`;

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

  fastify.log.info({ 
    speech: speechResult, 
    tenant: tenant?.tenant_id,
    hasAirtable: !!(tenant?.airtable_base_id && tenant?.airtable_table_name)
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

    // Detect appointment-related requests
    if (lowerSpeech.includes('appointment') || 
        lowerSpeech.includes('book') || 
        lowerSpeech.includes('schedule') || 
        lowerSpeech.includes('cancel') || 
        lowerSpeech.includes('reschedule') ||
        lowerSpeech.includes('look') ||
        lowerSpeech.includes('check') ||
        lowerSpeech.includes('find') ||
        lowerSpeech.includes('have any')) {
      
      fastify.log.info({ phone: fromNumber }, "Appointment request detected - calling Airtable");
      
      const appointmentResult = await callAirtableAPI(tenant, 'lookup_appointments', {
        phone: fromNumber
      });
      
      if (appointmentResult.handled) {
        response.say(appointmentResult.speech);
        handled = true;
      }
    }

    // If not appointment request, use OpenAI
    if (!handled) {
      const knowledgeText = loadKnowledgeFor(tenant);
      const systemPrompt = buildVoicePrompt(tenant, knowledgeText);

      const completion = await openai.chat.completions.create({
        model: tenant?.voice_config?.model || tenant?.model || "gpt-4o-mini",
        temperature: tenant?.voice_config?.temperature || tenant?.temperature ?? 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: speechResult }
        ],
        max_tokens: 100
      });

      const aiResponse = completion.choices?.[0]?.message?.content?.trim() || 
        "I'm sorry, I couldn't process that right now.";
      
      response.say(aiResponse);
    }

    // Continue conversation
    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 6
    });

    response.say("Anything else?");

  } catch (err) {
    fastify.log.error({ err }, "Speech processing error");
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

  const response = new twilio.twiml.MessagingResponse();

  try {
    if (body.toLowerCase().includes('appointment') || 
        body.toLowerCase().includes('book') || 
        body.toLowerCase().includes('cancel')) {
      
      const result = await callAirtableAPI(tenant, 'lookup_appointments', { phone: fromNumber });
      response.message(result.speech || "Please call us for appointment help.");
    } else {
      const bookingUrl = tenant?.booking?.main_url || tenant?.booking_url || "our online portal";
      response.message(`Thanks for texting! Call us or visit our portal for assistance.`);
    }
  } catch (err) {
    fastify.log.error({ err }, "SMS error");
    response.message("Sorry, technical issues. Please call us.");
  }

  reply.type("text/xml").send(response.toString());
});

// Test endpoints
fastify.get("/test/:tenantId", async (req, reply) => {
  const baseTenant = TENANTS[req.params.tenantId];
  if (!baseTenant) {
    return { error: "Tenant not found", available: Object.keys(TENANTS) };
  }
  
  const fullTenant = getTenantByToNumber(baseTenant.phone_number);

  return {
    tenant_id: fullTenant?.tenant_id,
    has_airtable: !!(fullTenant?.airtable_base_id && fullTenant?.airtable_table_name),
    phone_normalized: normalizePhone(fullTenant?.phone_number),
    booking_url: fullTenant?.booking?.main_url || fullTenant?.booking_url || "not configured",
    has_detailed_config: !!TENANT_DETAILS.has(req.params.tenantId)
  };
});

fastify.get("/test-airtable/:tenantId", async (req, reply) => {
  const baseTenant = TENANTS[req.params.tenantId];
  const { phone } = req.query;
  
  if (!baseTenant) {
    return { error: "Tenant not found" };
  }

  if (!phone) {
    return { error: "Phone parameter required for testing" };
  }

  const fullTenant = getTenantByToNumber(baseTenant.phone_number);
  const result = await callAirtableAPI(fullTenant, 'lookup_appointments', { phone });
  return result;
});

// ---------------- START SERVER ----------------
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 LocSync Voice Bot with Airtable running on ${address}`);
  console.log(`📞 Configured tenants: ${Object.keys(TENANTS).join(", ")}`);
});
