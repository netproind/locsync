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
  return phone.replace(/\D/g, '').slice(-10); // Keep last 10 digits
}

// Phone matching for sheet lookups
function phoneMatch(phone1, phone2) {
  return normalizePhone(phone1) === normalizePhone(phone2);
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
    // Fallback to general knowledge.md
    if (fs.existsSync("./knowledge.md")) {
      return fs.readFileSync("./knowledge.md", "utf8");
    }
  } catch (err) {
    fastify.log.warn({ err }, "Error loading knowledge");
  }
  return "";
}

// Build special instructions
function buildSpecialInstructions(tenant) {
  const instructions = [];
  if (Array.isArray(tenant?.special_instructions)) {
    tenant.special_instructions.forEach(instruction => {
      if (instruction && typeof instruction === "string") {
        instructions.push(`- ${instruction}`);
      }
    });
  }
  return instructions.length ? `Special Instructions:\n${instructions.join("\n")}` : "";
}

// Build voice prompt
function buildVoicePrompt(tenant, knowledgeText, appointmentContext = "") {
  const t = tenant || {};
  const services = (t.services || []).join(", ");
  const pricing = (t.pricing_notes || []).join(" | ");
  const policies = (t.policies || []).join(" | ");
  const hours = t.hours_string || "Please call during business hours";
  const location = t.location || "Location available upon request";
  const bookingLine = t.booking_url ? `- Online Booking: ${t.booking_url}` : "";

  const canonicalQA = (t.canonical_answers || [])
    .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`)
    .join("\n") || "(none)";

  const overrides = (t.overrides || [])
    .map(o => `IF user says /${o.match}/ THEN reply: "${o.reply}"`)
    .join("\n");

  const special = buildSpecialInstructions(t);
  
  const fileCap = t.kb_per_file_char_cap || 10000;
  const kbText = (knowledgeText || "").slice(0, fileCap);

  let prompt = `You are the virtual receptionist for "${t.studio_name || 'our salon'}" in ${t.timezone || "America/Detroit"}.

IMPORTANT: Keep responses under 20 seconds. Be warm, professional, and direct.

Salon Information:
- Name: ${t.studio_name || 'The Salon'}
- Location: ${location}
- Hours: ${hours}
${bookingLine}
- Services: ${services || "Hair care services"}
- Pricing: ${pricing || "Pricing available upon consultation"}
- Policies: ${policies || "Standard salon policies apply"}

${appointmentContext ? `Current Appointment Info:\n${appointmentContext}\n` : ""}

${special}

Canonical Q&A (use these exact responses):
${canonicalQA}

${overrides ? `OVERRIDE RULES:\n${overrides}\n` : ""}

Knowledge Base:
${kbText}

Remember: Answer directly, don't repeat the question, keep it under 20 seconds.`;

  const instrCap = t.instructions_char_cap || 24000;
  if (prompt.length > instrCap) {
    prompt = prompt.slice(0, instrCap);
  }
  
  return prompt;
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
      headers: {
        'Accept': 'application/json',
      },
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
      speech: "I'm having trouble accessing our appointment system. Please call back in a few minutes or visit our website." 
    };
  }
}

// Enhanced appointment checking
async function checkAppointments(tenant, callerPhone) {
  if (!callerPhone) {
    return { 
      handled: false, 
      speech: "I need your phone number to look up appointments. Could you please provide it?" 
    };
  }

  const result = await callGoogleSheetsAPI(tenant, 'appt_lookup', {
    phone: callerPhone
  });

  if (result.handled) {
    return result;
  }

  // Fallback response
  return {
    handled: true,
    speech: "I couldn't find any appointments under this number. Would you like to book a new appointment? You can visit our online booking portal."
  };
}

// Handle booking requests
async function handleBookingRequest(tenant, speechText, callerPhone) {
  // Check for booking keywords
  const bookingKeywords = ['book', 'appointment', 'schedule', 'available', 'slot'];
  const hasBookingIntent = bookingKeywords.some(keyword => 
    speechText.toLowerCase().includes(keyword)
  );

  if (!hasBookingIntent) {
    return { handled: false };
  }

  // Check available slots
  const result = await callGoogleSheetsAPI(tenant, 'slots_list', {
    date: new Date().toISOString().split('T')[0] // Today's date
  });

  if (result.handled && result.speech) {
    return result;
  }

  // Fallback booking response
  const bookingUrl = tenant.booking_url || "our website";
  return {
    handled: true,
    speech: `I'd be happy to help you book an appointment. Please visit ${bookingUrl} to see available times and book online, or I can help you find our next available slot.`
  };
}

// ---------------- ROUTES ----------------
fastify.get("/", async () => {
  return { 
    status: "ok", 
    service: "LocSync Voice Agent",
    version: "2.0",
    tenants: Object.keys(TENANTS).length 
  };
});

// Health check for Render
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

  fastify.log.info({ 
    speech: speechResult, 
    tenant: tenant?.tenant_id,
    from: fromNumber,
    to: toNumber 
  }, "Processing speech");

  const response = new twiml();

  if (!speechResult) {
    response.say("I didn't catch that. Please call back and speak clearly after the greeting.");
    response.hangup();
    reply.type("text/xml").send(response.toString());
    return;
  }

  try {
    let appointmentContext = "";
    let handled = false;
    let aiResponse = "";

    // Check for appointment-related intents first
    const lowerSpeech = speechResult.toLowerCase();
    
    if (lowerSpeech.includes('appointment') || lowerSpeech.includes('book') || 
        lowerSpeech.includes('schedule') || lowerSpeech.includes('cancel') || 
        lowerSpeech.includes('reschedule')) {
      
      if (lowerSpeech.includes('cancel') || lowerSpeech.includes('reschedule')) {
        // Handle existing appointment lookup
        const appointmentResult = await checkAppointments(tenant, fromNumber);
        if (appointmentResult.handled) {
          response.say(appointmentResult.speech);
          handled = true;
        }
      } else {
        // Handle new booking request
        const bookingResult = await handleBookingRequest(tenant, speechResult, fromNumber);
        if (bookingResult.handled) {
          response.say(bookingResult.speech);
          handled = true;
        }
      }
    }

    // If not handled by appointment logic, use OpenAI
    if (!handled) {
      const knowledgeText = loadKnowledgeFor(tenant);
      const systemPrompt = buildVoicePrompt(tenant, knowledgeText, appointmentContext);

      const model = tenant?.model || "gpt-4o-mini";
      const temperature = tenant?.temperature ?? 0.7;

      const completion = await openai.chat.completions.create({
        model,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: speechResult }
        ],
        max_tokens: 150 // Keep responses concise for voice
      });

      aiResponse = completion.choices?.[0]?.message?.content?.trim() || 
        "I'm sorry, I couldn't process that request right now.";
      
      response.say(aiResponse);
    }

    // Add follow-up option
    response.gather({
      input: "speech",
      action: "/handle-follow-up",
      method: "POST",
      timeout: 5,
      speechTimeout: "auto"
    });

    response.say("Is there anything else I can help you with?");
    response.hangup();

  } catch (err) {
    fastify.log.error({ err }, "Error processing speech");
    response.say("I'm experiencing technical difficulties. Please try calling back in a few minutes.");
    response.hangup();
  }

  reply.type("text/xml").send(response.toString());
});

// Follow-up handler
fastify.post("/handle-follow-up", async (req, reply) => {
  const speechResult = req.body?.SpeechResult?.trim() || "";
  const response = new twiml();

  if (!speechResult || speechResult.toLowerCase().includes('no') || 
      speechResult.toLowerCase().includes('nothing')) {
    response.say("Thank you for calling. Have a great day!");
    response.hangup();
  } else {
    // Redirect back to main speech handler
    response.redirect("/handle-speech");
  }

  reply.type("text/xml").send(response.toString());
});

// SMS handler (for A2P compliance)
fastify.post("/incoming-sms", async (req, reply) => {
  const body = req.body?.Body?.trim() || "";
  const fromNumber = (req.body?.From || "").trim();
  const toNumber = (req.body?.To || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({ 
    body, 
    from: fromNumber, 
    to: toNumber, 
    tenant: tenant?.tenant_id 
  }, "Incoming SMS");

  const response = new twilio.twiml.MessagingResponse();

  try {
    // Handle appointment-related SMS
    if (body.toLowerCase().includes('appointment') || 
        body.toLowerCase().includes('book') || 
        body.toLowerCase().includes('cancel')) {
      
      const appointmentResult = await checkAppointments(tenant, fromNumber);
      response.message(appointmentResult.speech);
    } else {
      // AI response for general inquiries
      const knowledgeText = loadKnowledgeFor(tenant);
      const systemPrompt = `You are texting as the receptionist for ${tenant?.studio_name || 'the salon'}. 
Keep responses under 160 characters. Be helpful and direct.

Knowledge: ${knowledgeText.slice(0, 2000)}`;

      const completion = await openai.chat.completions.create({
        model: tenant?.model || "gpt-4o-mini",
        temperature: 0.5,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: body }
        ],
        max_tokens: 50
      });

      const aiResponse = completion.choices?.[0]?.message?.content?.trim() || 
        "Thanks for texting! Please call us or visit our website for assistance.";
      
      response.message(aiResponse);
    }
  } catch (err) {
    fastify.log.error({ err }, "SMS processing error");
    response.message("Sorry, I'm having technical issues. Please call us directly.");
  }

  reply.type("text/xml").send(response.toString());
});

// Test endpoint for checking tenant setup
fastify.get("/test/:tenantId", async (req, reply) => {
  const { tenantId } = req.params;
  const tenant = TENANTS[tenantId];
  
  if (!tenant) {
    return { error: "Tenant not found", available: Object.keys(TENANTS) };
  }

  const knowledge = loadKnowledgeFor(tenant);
  
  return {
    tenant: {
      ...tenant,
      // Don't expose sensitive data in test endpoint
      sheets_web_app_url: tenant.sheets_web_app_url ? "configured" : "missing"
    },
    knowledge_length: knowledge.length,
    phone_normalized: normalizePhone(tenant.phone_number)
  };
});

// Test Google Sheets connection
fastify.get("/test-sheets/:tenantId", async (req, reply) => {
  const { tenantId } = req.params;
  const { phone, action = 'appt_lookup' } = req.query;
  
  const tenant = TENANTS[tenantId];
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
