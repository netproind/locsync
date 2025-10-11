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
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------- SIMPLIFIED VOICE RESPONSE (NO ELEVENLABS) ----------------
async function respondWithNaturalVoice(response, text, tenant) {
  // Use Twilio TTS only - simple and reliable
  response.say({
    voice: 'Polly.Joanna-Neural'
  }, text);
  fastify.log.info('Using Twilio TTS');
  return false;
}

// ---------------- ENHANCED TENANT LOADING ----------------
let TENANTS = {};
let TENANT_DETAILS = new Map();

try {
  TENANTS = JSON.parse(fs.readFileSync("./tenants.json", "utf8"));
  fastify.log.info("✅ Loaded tenants registry");
} catch (e) {
  fastify.log.warn("⚠️ No tenants.json found. Using defaults.");
}

// Function to extract URLs from text
function extractUrls(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

// ENHANCED SMS function with dynamic service-specific messaging
async function sendLinksViaSMS(fromNumber, toNumber, links, tenant, serviceType = null) {
  if (!links.length || !tenant?.voice_config?.send_links_via_sms) return;
  
  try {
    let message = "";
    
    if (links.length === 1) {
      const link = links[0];
      
      // Check if tenant has service portal for quote-based messaging
      if (tenant?.advanced_features?.service_portal) {
        // Service-specific messaging for quote-based salons
        if (serviceType === 'wick_maintenance') {
          message = `Wick Locs Maintenance Quote: ${link}`;
        } else if (serviceType === 'bald_coverage') {
          message = `Bald Coverage Quote: ${link}`;
        } else if (serviceType === 'repair') {
          message = `Loc Repair Quote: ${link}`;
        } else if (serviceType === 'starter_locs') {
          message = `Starter Locs Quote: ${link}`;
        } else if (serviceType === 'sisterlocks') {
          message = `Sisterlocks Maintenance Quote: ${link}`;
        } else if (serviceType === 'service_portal') {
          message = `Service Portal - Get personalized quotes: ${link}`;
        }
      }
      
      // Direct booking messaging for all salons (including returning clients)
      if (serviceType === 'retwist_booking') {
        message = `Book your Retwist/Palm Roll appointment: ${link}`;
      } else if (serviceType === 'wick_booking') {
        message = `Book your Wick Loc maintenance appointment: ${link}`;
      } else if (serviceType === 'interlock_booking') {
        message = `Book your Interlock maintenance appointment: ${link}`;
      } else if (serviceType === 'sisterlock_booking') {
        message = `Book your Sisterlock/Microlock maintenance appointment: ${link}`;
      } else if (serviceType === 'crochet_booking') {
        message = `Book your Crochet Roots maintenance appointment: ${link}`;
      } else if (serviceType === 'bald_coverage_booking') {
        message = `Book your Bald Coverage maintenance appointment: ${link}`;
      } else if (serviceType === 'consultation_booking') {
        message = `Book your consultation appointment: ${link}`;
      }
      
      // Universal messaging
      if (serviceType === 'website') {
        message = `Visit our website for language support chatbot: ${link}`;
      } else if (serviceType === 'instagram') {
        message = `Follow us on Instagram: ${link}`;
      } else if (serviceType === 'appointment_lookup') {
        message = `Appointment Lookup - Find and manage your appointments: ${link}`;
      } else if (link.includes('directions')) {
        message = `Here are the detailed directions to our door: ${link}`;
      } else if (!message) {
        message = `Here's the link we mentioned: ${link}`;
      }
    } else {
      message = `Here are the links we mentioned:\n${links.map((link, i) => {
        if (link.includes('service_portal')) return `${i + 1}. Service Portal: ${link}`;
        if (link.includes('directions')) return `${i + 1}. Directions: ${link}`;
        if (link.includes('instagram')) return `${i + 1}. Instagram: ${link}`;
        if (link.includes('appointment-lookup')) return `${i + 1}. Appointment Lookup: ${link}`;
        return `${i + 1}. ${link}`;
      }).join('\n')}`;
    }
    
    await twilioClient.messages.create({
      body: message,
      from: toNumber,
      to: fromNumber
    });
    
    fastify.log.info({ 
      fromNumber, 
      linkCount: links.length, 
      serviceType, 
      messageType: 'service_link' 
    }, "SMS sent successfully");
    
  } catch (err) {
    fastify.log.error({ err, fromNumber, serviceType }, "Failed to send SMS");
  }
}

// FIXED: Function to get booking link based on service type and tenant capabilities
function getServiceBookingLink(serviceType, tenant, isReturningClient = false) {
  // For returning clients with advanced flow, prioritize direct booking links
  if (isReturningClient && tenant?.advanced_features?.new_vs_returning_flow) {
    // Check for maintenance booking links (direct booking) first for returning clients
    if (tenant?.maintenance_booking_links?.links) {
      const link = tenant.maintenance_booking_links.links[serviceType];
      if (link) return { url: link, type: 'booking' };
    }
    
    // Check legacy booking config
    if (tenant?.booking?.maintenance_links) {
      const link = tenant.booking.maintenance_links[serviceType];
      if (link) return { url: link, type: 'booking' };
    }
  }
  
  // For new clients or when no direct booking available, check quote system
  if (tenant?.advanced_features?.quote_system && tenant?.quote_system?.urls) {
    const link = tenant.quote_system.urls[serviceType];
    if (link) return { url: link, type: 'quote' };
  }
  
  // Check for maintenance booking links (direct booking)
  if (tenant?.maintenance_booking_links?.links) {
    const link = tenant.maintenance_booking_links.links[serviceType];
    if (link) return { url: link, type: 'booking' };
  }
  
  // Check legacy booking config
  if (tenant?.booking?.maintenance_links) {
    const link = tenant.booking.maintenance_links[serviceType];
    if (link) return { url: link, type: 'booking' };
  }
  
  // Fallback to consultation or main booking URL
  if (tenant?.booking?.consultation_url) {
    return { url: tenant.booking.consultation_url, type: 'consultation' };
  }
  
  return { url: tenant?.booking?.main_url || null, type: 'general' };
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
    const details = loadTenantDetails(baseTenant.tenant_id);
    return { ...baseTenant, ...details };
  }
  
  return baseTenant;
}

// Load tenant knowledge
function loadKnowledgeFor(tenant) {
  try {
    if (tenant?.tenant_id) {
      const tenantKnowledgePath = `./tenants/${tenant.tenant_id}/knowledge.md`;
      if (fs.existsSync(tenantKnowledgePath)) {
        const tenantKnowledge = fs.readFileSync(tenantKnowledgePath, "utf8");
        
        if (fs.existsSync("./knowledge.md")) {
          const universalKnowledge = fs.readFileSync("./knowledge.md", "utf8");
          return universalKnowledge + "\n\n" + tenantKnowledge;
        }
        return tenantKnowledge;
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

// DYNAMIC voice prompt builder based on tenant capabilities
function buildVoicePrompt(tenant, knowledgeText) {
  const t = tenant || {};
  
  const services = (t.services?.primary || t.services || []).join(", ");
  const hours = t.hours?.hours_string || t.hours_string || "Please call during business hours";
  
  const loctician = t.loctician_name || "our stylist";
  const experience = t.experience_years ? `${t.experience_years} years experience` : "";
  const specialties = (t.services?.specialties || t.specialties || []).join(", ");
  
  const website = t.contact?.website || t.website || "";
  const instagram = t.contact?.instagram_handle || t.instagram_handle || "";
  const address = t.address ? `Located at ${t.address}` : "";
  
  // Dynamic greeting based on tenant config
  const customGreeting = t.voice_config?.greeting_tts || 
    `Thank you for calling ${t.studio_name || 'our salon'}. How can I help you?`;
  
  // Determine booking flow based on tenant features
  let appointmentFlow = "";
  if (t.advanced_features?.service_portal && t.advanced_features?.new_vs_returning_flow) {
    appointmentFlow = `
APPOINTMENT BOOKING FLOW:
When someone requests an appointment:
1. ALWAYS ask: "Are you a new client or a returning client?"
2. NEW CLIENT: Send service portal link via SMS for quotes
3. RETURNING CLIENT: Ask "What service do you usually get?" then send DIRECT BOOKING LINK (not quote link)`;
  } else {
    appointmentFlow = `
APPOINTMENT BOOKING FLOW:
When someone requests an appointment:
1. Ask what service they need
2. Send appropriate booking link or consultation link
3. If unsure, send consultation booking link`;
  }
  
  // Service-specific responses based on what tenant offers
  let serviceResponses = "";
  if (t.services?.quote_urls || t.quote_system?.urls) {
    serviceResponses += "For NEW CLIENT service quotes, use the quote URLs from the tenant configuration.\n";
  }
  if (t.maintenance_booking_links?.links || t.booking?.maintenance_links) {
    serviceResponses += "For RETURNING CLIENT maintenance bookings, use the direct booking links from tenant configuration.\n";
  }
  if (t.booking?.consultation_url) {
    serviceResponses += "For consultations, use the consultation booking URL.\n";
  }
  
  // Training program info (if available)
  let trainingInfo = "";
  if (t.training_program?.enabled || t.advanced_features?.training_program) {
    trainingInfo = `
Training Program: ${t.training_program?.cost || "Available"} - ${t.training_program?.signup_method || "Contact for details"}`;
  }

  // Build canonical Q&A from tenant config
  const canonicalQA = (t.canonical_answers || [])
    .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`)
    .join("\n") || "(Use general responses)";

  let prompt = `You are the virtual receptionist for "${t.studio_name || 'our salon'}" with ${loctician}${experience ? ` (${experience})` : ""}.

CRITICAL INSTRUCTIONS:
- Keep responses under 15 seconds
- Never spell out URLs - just say "visit our website" or "check our portal"
- DO NOT repeat or rephrase the customer's question back to them
- Answer directly and naturally
- Be conversational and helpful
- Always offer to text helpful links and directions
- Acknowledge when clients are running late and inform them ${loctician} is notified
- When providing address, always say the full street address clearly
- For non-English speakers, offer callback options or texting for translation help
- When texting links, always mention what type of link you're sending
- IMPORTANT: For returning clients, send DIRECT BOOKING LINKS, not quote links

${appointmentFlow}

Salon Information:
- Name: ${t.studio_name || 'The Salon'}
- Loctician: ${loctician}${experience ? ` - ${experience}` : ""}
- Hours: ${hours}
- Services: ${services || "Hair care services"}
${specialties ? `- Specialties: ${specialties}` : ""}
${address}

${serviceResponses}
${trainingInfo}

${website ? `Website: ${website}` : ""}
${instagram ? `Instagram: ${instagram}` : ""}

Canonical Q&A (use these exact responses when applicable):
${canonicalQA}

Knowledge Base:
${(knowledgeText || "").slice(0, 8000)}

Remember: Be conversational, direct, and never spell out web addresses. Answer questions directly without repeating them. NEW CLIENTS get quotes, RETURNING CLIENTS get direct booking links.`;

  return prompt.slice(0, 15000);
}

// Airtable API integration - SIMPLIFIED (only for existing appointment lookups)
async function callAirtableAPI(tenant, action, params = {}, requestType = 'lookup') {
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
      return processAppointmentLookup(data.records || [], params.phone, tenant, requestType);
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

// Process appointment lookup results - SIMPLIFIED (only for existing appointment management)
function processAppointmentLookup(records, searchPhone, tenant, requestType = 'lookup') {
  if (records.length === 0) {
    return {
      handled: true,
      speech: `I don't see any appointments under your number. Would you like to book a new appointment?`,
      data: { appointments: [], needsBooking: true }
    };
  }

  const appointments = records.map(record => ({
    service: record.fields.service || 'Service',
    date: record.fields.start_iso || record.fields.date,
    time: record.fields.time || extractTimeFromDate(record.fields.start_iso || record.fields.date),
    status: record.fields.status || 'scheduled',
    client_name: record.fields.client_first || 'Client'
  }));

  const now = new Date();
  const upcoming = appointments.filter(apt => {
    if (!apt.date) return true;
    try {
      return new Date(apt.date) >= now;
    } catch {
      return true;
    }
  });

  if (upcoming.length === 0) {
    return {
      handled: true,
      speech: `I don't see any upcoming appointments under your number. Would you like to schedule a new appointment?`,
      data: { appointments: [], needsBooking: true }
    };
  }

  if (requestType === 'time' || requestType === 'when') {
    if (upcoming.length === 1) {
      const next = upcoming[0];
      const timeInfo = next.time ? ` at ${next.time}` : '';
      const dateInfo = next.date ? formatAppointmentDate(next.date) : '';
      return {
        handled: true,
        speech: `Your ${next.service} appointment is scheduled for ${dateInfo}${timeInfo}.`,
        data: { appointments: upcoming }
      };
    } else {
      const allAppts = upcoming.map((apt, i) => {
        const aptTime = apt.time ? ` at ${apt.time}` : '';
        const aptDate = apt.date ? formatAppointmentDate(apt.date) : '';
        return `${apt.service} on ${aptDate}${aptTime}`;
      });
      
      return {
        handled: true,
        speech: `You have ${upcoming.length} upcoming appointments: ${allAppts.join(', and ')}. Which appointment did you want to know about?`,
        data: { appointments: upcoming }
      };
    }
  }

  if (requestType === 'manage' || requestType === 'cancel' || requestType === 'reschedule') {
    if (upcoming.length === 1) {
      const next = upcoming[0];
      const timeInfo = next.time ? ` at ${next.time}` : '';
      const dateInfo = next.date ? formatAppointmentDate(next.date) : '';
      return {
        handled: true,
        speech: `You have an appointment for ${next.service} on ${dateInfo}${timeInfo}. I'm texting you the confirmation link to manage it.`,
        data: { appointments: upcoming, sendConfirmation: true }
      };
    } else {
      const allAppts = upcoming.map((apt, i) => {
        const aptTime = apt.time ? ` at ${apt.time}` : '';
        const aptDate = apt.date ? formatAppointmentDate(apt.date) : '';
        return `${i + 1}. ${apt.service} on ${aptDate}${aptTime}`;
      });
      
      return {
        handled: true,
        speech: `You have ${upcoming.length} appointments: ${allAppts.join(', ')}. Which appointment would you like to manage? I'm texting you the confirmation link to help you manage any of them.`,
        data: { appointments: upcoming, sendConfirmation: true, needsSelection: true }
      };
    }
  }

  if (upcoming.length === 1) {
    const next = upcoming[0];
    const timeInfo = next.time ? ` at ${next.time}` : '';
    const dateInfo = next.date ? formatAppointmentDate(next.date) : '';
    return {
      handled: true,
      speech: `You have an appointment for ${next.service} scheduled for ${dateInfo}${timeInfo}. How can I help you with it?`,
      data: { appointments: upcoming }
    };
  } else {
    const allAppts = upcoming.map((apt, i) => {
      const aptTime = apt.time ? ` at ${apt.time}` : '';
      const aptDate = apt.date ? formatAppointmentDate(apt.date) : '';
      return `${i + 1}. ${apt.service} on ${aptDate}${aptTime}`;
    });
    
    return {
      handled: true,
      speech: `You have ${upcoming.length} upcoming appointments: ${allAppts.join(', and ')}. Which appointment would you like help with, or would you like to manage all of them?`,
      data: { appointments: upcoming }
    };
  }
}

// Helper function to extract time from date string
function extractTimeFromDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
  } catch {
    return '';
  }
}

// Helper function to format appointment date
function formatAppointmentDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
      weekday: 'long',
      month: 'long', 
      day: 'numeric'
    });
  } catch {
    return dateStr;
  }
}

// ---------------- ROUTES ----------------
fastify.get("/", async () => {
  return { 
    status: "ok", 
    service: "LocSync Voice Agent - Multi-Tenant",
    tenants: Object.keys(TENANTS).length,
    voice: "Twilio TTS (Polly.Joanna-Neural)"
  };
});

fastify.get("/health", async () => {
  return { 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    voice: "Twilio TTS"
  };
});

// Incoming call handler - SIMPLIFIED (NO ELEVENLABS)
fastify.post("/incoming-call", async (req, reply) => {
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({ to: toNumber, from: fromNumber, tenant: tenant?.tenant_id }, "📞 Incoming call");

  const response = new twiml();
  
  // Use tenant-specific greeting or fallback
  const greeting = tenant?.voice_config?.greeting_tts || 
    `Thank you for calling ${tenant?.studio_name || "our salon"}. How can I help you?`;

  // SIMPLE TWILIO TTS - NO ELEVENLABS
  response.say({
    voice: 'Polly.Joanna-Neural'
  }, greeting);
  
  response.gather({
    input: "speech",
    action: "/handle-speech",
    method: "POST",
    timeout: 10,
    speechTimeout: "auto"
  });

  reply.type("text/xml").send(response.toString());
});

// SMS handler - simplified and tenant-aware
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
      const salonName = tenant?.studio_name || "our salon";
      response.message(`Thanks for texting ${salonName}! Call us or visit our portal for assistance.`);
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
    salon_name: fullTenant?.studio_name || fullTenant?.salon_name,
    has_airtable: !!(fullTenant?.airtable_base_id && fullTenant?.airtable_table_name),
    phone_normalized: normalizePhone(fullTenant?.phone_number),
    has_service_portal: !!fullTenant?.advanced_features?.service_portal,
    has_quote_system: !!fullTenant?.advanced_features?.quote_system,
    has_training_program: !!fullTenant?.advanced_features?.training_program,
    booking_url: fullTenant?.booking?.main_url || fullTenant?.booking_url || "not configured",
    consultation_url: fullTenant?.booking?.consultation_url || "not configured",
    has_detailed_config: !!TENANT_DETAILS.has(req.params.tenantId),
    voice: "Twilio TTS (Polly.Joanna-Neural)",
    features: {
      multilingual_support: !!fullTenant?.advanced_features?.multilingual_support,
      new_vs_returning_flow: !!fullTenant?.advanced_features?.new_vs_returning_flow,
      maintenance_booking_links: !!fullTenant?.advanced_features?.maintenance_booking_links
    }
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

// Get tenant features endpoint
fastify.get("/tenant-features/:tenantId", async (req, reply) => {
  const baseTenant = TENANTS[req.params.tenantId];
  if (!baseTenant) {
    return { error: "Tenant not found" };
  }
  
  const fullTenant = getTenantByToNumber(baseTenant.phone_number);
  
  return {
    tenant_id: fullTenant?.tenant_id,
    salon_name: fullTenant?.studio_name || fullTenant?.salon_name,
    features: fullTenant?.advanced_features || {},
    services: fullTenant?.services?.primary || [],
    specialties: fullTenant?.services?.specialties || [],
    has_quote_urls: !!(fullTenant?.services?.quote_urls || fullTenant?.quote_system?.urls),
    has_maintenance_links: !!(fullTenant?.maintenance_booking_links?.links || fullTenant?.booking?.maintenance_links),
    has_consultation: !!fullTenant?.booking?.consultation_url,
    canonical_answers_count: fullTenant?.canonical_answers?.length || 0,
    voice: "Twilio TTS (Polly.Joanna-Neural)"
  };
});

// Handle speech input - DYNAMIC based on tenant capabilities with RETURNING CLIENT FIX
fastify.post("/handle-speech", async (req, reply) => {
  const speechResult = req.body?.SpeechResult?.trim() || "";
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({ 
    speech: speechResult, 
    tenant: tenant?.tenant_id,
    hasServicePortal: !!tenant?.advanced_features?.service_portal,
    hasQuoteSystem: !!tenant?.advanced_features?.quote_system
  }, "Processing speech");

  const response = new twiml();

  if (!speechResult) {
    await respondWithNaturalVoice(response, "I didn't catch that clearly. Could you please repeat what you need? I'm still here to help.", tenant);
    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 10,
speechTimeout: "auto"
    });
    await respondWithNaturalVoice(response, "I'm waiting for your response.", tenant);
    reply.type("text/xml").send(response.toString());
    return;
  }

  try {
    const lowerSpeech = speechResult.toLowerCase();
    let handled = false;

    // Enhanced multilingual support (if enabled)
    if (tenant?.advanced_features?.multilingual_support) {
      if (lowerSpeech.includes('español') || lowerSpeech.includes('spanish') || 
          lowerSpeech.includes('habla español') || lowerSpeech.includes('hablas español') ||
          lowerSpeech.includes('en español') || lowerSpeech.includes('no hablo inglés') ||
          lowerSpeech.includes('no hablo ingles')) {
        await respondWithNaturalVoice(response, "Para soporte en español, puede usar nuestro chat bot en nuestro sitio web. Está en la esquina inferior derecha. Le envío el enlace por mensaje de texto ahora.", tenant);
        const websiteLinks = [tenant?.contact?.website || tenant?.website];
        if (websiteLinks[0]) {
          await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant, 'website');
        }
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        await respondWithNaturalVoice(response, "¿Hay algo más en que pueda ayudarle?", tenant);
        handled = true;
      }
    }
    
    // Website/Instagram requests
    if (!handled && (lowerSpeech.includes('website') || lowerSpeech.includes('web site') ||
         lowerSpeech.includes('online') || lowerSpeech.includes('url'))) {
      await respondWithNaturalVoice(response, "I'm texting you our website link now so you can easily access it.", tenant);
      const websiteLinks = [tenant?.contact?.website || tenant?.website];
      if (websiteLinks[0]) {
        await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant, 'website');
      }
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      handled = true;
    }
    
    else if (!handled && (lowerSpeech.includes('instagram') || lowerSpeech.includes('insta') ||
             lowerSpeech.includes('social media'))) {
      await respondWithNaturalVoice(response, "I'm texting you our Instagram link now.", tenant);
      const instaLinks = [tenant?.contact?.instagram_url || tenant?.contact?.instagram_handle];
      if (instaLinks[0]) {
        await sendLinksViaSMS(fromNumber, toNumber, instaLinks, tenant, 'instagram');
      }
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      handled = true;
    }
    
    // DYNAMIC APPOINTMENT BOOKING based on tenant capabilities
    if (!handled && (lowerSpeech.includes('need an appointment') || lowerSpeech.includes('need appointment') ||
         lowerSpeech.includes('want an appointment') || lowerSpeech.includes('want appointment') ||
         lowerSpeech.includes('book an appointment') || lowerSpeech.includes('book appointment') ||
         lowerSpeech.includes('schedule an appointment') || lowerSpeech.includes('schedule appointment') ||
         lowerSpeech.includes('looking for slot') || lowerSpeech.includes('slot availability') ||
         lowerSpeech.includes('slots available') || lowerSpeech.includes('availability'))) {
      
      if (tenant?.advanced_features?.service_portal && tenant?.advanced_features?.new_vs_returning_flow) {
        // Use advanced flow for quote-based salons (like Loc Repair Clinic)
        await respondWithNaturalVoice(response, "Are you a new client or a returning client?", tenant);
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        await respondWithNaturalVoice(response, "Please let me know if you're new or returning so I can help you book the right way.", tenant);
      } else {
        // Use simple flow for direct booking salons
        await respondWithNaturalVoice(response, "What service are you looking for? I can help you get booked.", tenant);
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        await respondWithNaturalVoice(response, "Please let me know what service you need.", tenant);
      }
      handled = true;
    }
    
    // Handle new/returning client responses (only for advanced flow)
    if (!handled && tenant?.advanced_features?.new_vs_returning_flow) {
      if (lowerSpeech.includes('new client') || lowerSpeech.includes('first time') || 
           lowerSpeech.includes('never been') || lowerSpeech.includes('new customer')) {
        await respondWithNaturalVoice(response, "Welcome! Since you're a new client, I'm texting you our service portal where you can get a personalized quote for your specific loc needs.", tenant);
        const servicePortalLink = tenant?.service_portal?.url || tenant?.booking?.main_url;
        if (servicePortalLink) {
          await sendLinksViaSMS(fromNumber, toNumber, [servicePortalLink], tenant, 'service_portal');
        }
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
        handled = true;
      }
      
      else if (lowerSpeech.includes('returning client') || lowerSpeech.includes('been here before') ||
               lowerSpeech.includes('existing client') || lowerSpeech.includes('regular client') ||
               lowerSpeech.includes('come here before') || lowerSpeech.includes('returning customer')) {
        await respondWithNaturalVoice(response, "Great! Since you're a returning client, what service do you usually get? I can send you a direct booking link for your maintenance appointments.", tenant);
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        await respondWithNaturalVoice(response, "Which service would you like to book?", tenant);
        handled = true;
      }
    }
    
    // CRITICAL FIX: Handle returning client service selection responses with DIRECT BOOKING LINKS
    if (!handled && tenant?.advanced_features?.new_vs_returning_flow) {
      if (lowerSpeech.includes('retwist') || lowerSpeech.includes('palm roll')) {
        await respondWithNaturalVoice(response, "Perfect! I'm texting you the direct booking link for your retwist maintenance appointment.", tenant);
        const bookingLink = tenant?.booking?.maintenance_links?.retwist || tenant?.maintenance_booking_links?.links?.retwist;
        if (bookingLink) {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'retwist_booking');
        }
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
        handled = true;
      }
      
      else if (lowerSpeech.includes('wick')) {
        await respondWithNaturalVoice(response, "Perfect! I'm texting you the direct booking link for your wick loc maintenance appointment.", tenant);
        const bookingLink = tenant?.booking?.maintenance_links?.wick || tenant?.maintenance_booking_links?.links?.wick;
        if (bookingLink) {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'wick_booking');
        }
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
        handled = true;
      }
      
      else if (lowerSpeech.includes('interlock')) {
        await respondWithNaturalVoice(response, "Perfect! I'm texting you the direct booking link for your interlock maintenance appointment.", tenant);
        const bookingLink = tenant?.booking?.maintenance_links?.interlock || tenant?.maintenance_booking_links?.links?.interlock;
        if (bookingLink) {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'interlock_booking');
        }
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
        handled = true;
      }
      
      else if (lowerSpeech.includes('sisterlock') || lowerSpeech.includes('sister lock') || 
               lowerSpeech.includes('microlock') || lowerSpeech.includes('micro lock')) {
        await respondWithNaturalVoice(response, "Perfect! I'm texting you the direct booking link for your sisterlock maintenance appointment.", tenant);
        const bookingLink = tenant?.booking?.maintenance_links?.sisterlock || tenant?.maintenance_booking_links?.links?.sisterlock;
        if (bookingLink) {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'sisterlock_booking');
        }
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
        handled = true;
      }
      
      else if (lowerSpeech.includes('crochet')) {
        await respondWithNaturalVoice(response, "Perfect! I'm texting you the direct booking link for your crochet roots maintenance appointment.", tenant);
        const bookingLink = tenant?.booking?.maintenance_links?.crochet || tenant?.maintenance_booking_links?.links?.crochet;
        if (bookingLink) {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'crochet_booking');
        }
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
        handled = true;
      }
      
      else if (lowerSpeech.includes('bald coverage') || lowerSpeech.includes('bald spot') || lowerSpeech.includes('bald')) {
        await respondWithNaturalVoice(response, "Perfect! I'm texting you the direct booking link for your bald coverage maintenance appointment.", tenant);
        const bookingLink = tenant?.booking?.maintenance_links?.bald_coverage || tenant?.maintenance_booking_links?.links?.bald_coverage;
        if (bookingLink) {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'bald_coverage_booking');
        }
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
        handled = true;
      }
    }
    
    // Handle general service requests (for new clients or simple salons)
    const serviceHandlers = [
      { keywords: ['retwist', 'palm roll'], serviceType: 'retwist' },
      { keywords: ['wick'], serviceType: 'wick' },
      { keywords: ['interlock'], serviceType: 'interlock' },
      { keywords: ['sisterlock', 'sister lock', 'microlock', 'micro lock'], serviceType: 'sisterlock' },
      { keywords: ['crochet'], serviceType: 'crochet' },
      { keywords: ['bald coverage', 'bald spot', 'bald'], serviceType: 'bald_coverage' }
    ];
    
    if (!handled) {
      for (const handler of serviceHandlers) {
        if (handler.keywords.some(keyword => lowerSpeech.includes(keyword))) {
          const bookingInfo = getServiceBookingLink(handler.serviceType, tenant, false);
          
          if (bookingInfo.url) {
            let responseMessage = "";
            let smsServiceType = "";
            
            if (bookingInfo.type === 'booking') {
              responseMessage = `Perfect! I'm texting you the booking link for ${handler.serviceType.replace('_', ' ')} service.`;
              smsServiceType = `${handler.serviceType}_booking`;
            } else if (bookingInfo.type === 'quote') {
              responseMessage = `I'm texting you the quote link for ${handler.serviceType.replace('_', ' ')} service.`;
              smsServiceType = `${handler.serviceType}_maintenance`;
            } else if (bookingInfo.type === 'consultation') {
              responseMessage = `For ${handler.serviceType.replace('_', ' ')} service, let's start with a consultation. I'm texting you the consultation booking link.`;
              smsServiceType = 'consultation_booking';
            } else {
              responseMessage = `I'm texting you the link for ${handler.serviceType.replace('_', ' ')} service.`;
              smsServiceType = 'general';
            }
            
            await respondWithNaturalVoice(response, responseMessage, tenant);
            await sendLinksViaSMS(fromNumber, toNumber, [bookingInfo.url], tenant, smsServiceType);
          } else {
            await respondWithNaturalVoice(response, `We offer ${handler.serviceType.replace('_', ' ')} service. Please call us to schedule.`, tenant);
          }
          
          response.gather({
            input: "speech",
            action: "/handle-speech",
            method: "POST",
            timeout: 12,
            speechTimeout: "auto"
          });
          await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
          handled = true;
          break;
        }
      }
    }

    // Running late notification
    if (!handled && (lowerSpeech.includes('running late') || 
        lowerSpeech.includes('running behind') ||
        lowerSpeech.includes('late for') ||
        (lowerSpeech.includes('late') && lowerSpeech.includes('appointment')))) {
      
      const lateResponse = tenant?.custom_responses?.running_late || 
                          tenant?.quick_responses?.running_late ||
                          `Thanks for the update! ${tenant?.loctician_name || 'The stylist'} has been informed you're running behind.`;
      await respondWithNaturalVoice(response, lateResponse, tenant);
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      handled = true;
    }

    // Training program inquiries (if available)
    if (!handled && tenant?.advanced_features?.training_program && 
        (lowerSpeech.includes('training') || lowerSpeech.includes('course') || 
         lowerSpeech.includes('teach') || lowerSpeech.includes('learn'))) {
      
      const trainingInfo = tenant?.training_program;
      let trainingResponse = `Yes, we offer training. `;
      
      if (trainingInfo?.cost) {
        trainingResponse += `It's ${trainingInfo.cost}. `;
      }
      if (trainingInfo?.signup_method) {
        trainingResponse += `${trainingInfo.signup_method}.`;
      } else {
        trainingResponse += "Contact us for enrollment details.";
      }
      
      await respondWithNaturalVoice(response, trainingResponse, tenant);
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      handled = true;
    }
    
    // Hours inquiry with follow-up
    if (!handled && (lowerSpeech.includes('hour') || lowerSpeech.includes('open') || lowerSpeech.includes('close'))) {
      const hoursResponse = tenant?.custom_responses?.hours_with_portal || 
                           tenant?.hours?.hours_string || 
                           "Please call during business hours for availability.";
      
      await respondWithNaturalVoice(response, hoursResponse, tenant);
      
      // If they have a service portal, send it
      if (tenant?.advanced_features?.service_portal && tenant?.service_portal?.url) {
        const portalLinks = [tenant.service_portal.url];
        await sendLinksViaSMS(fromNumber, toNumber, portalLinks, tenant, 'service_portal');
      }
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      handled = true;
    }
    
    // Pricing-only requests
    if (!handled && ((lowerSpeech.includes('price') || lowerSpeech.includes('cost') || lowerSpeech.includes('pricing') || lowerSpeech.includes('how much')) &&
              !lowerSpeech.includes('appointment') && !lowerSpeech.includes('book') && !lowerSpeech.includes('schedule'))) {
      
      if (tenant?.advanced_features?.quote_system) {
        await respondWithNaturalVoice(response, "Our pricing is quote-based since everyone's needs are different. I'm texting you our service portal where you can get personalized pricing for your specific loc needs.", tenant);
        const bookingUrl = tenant?.service_portal?.url || tenant?.booking?.main_url;
        if (bookingUrl) {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingUrl], tenant, 'service_portal');
        }
      } else if (tenant?.booking?.consultation_url) {
        await respondWithNaturalVoice(response, "For pricing information, we recommend starting with a consultation. I'm texting you the consultation booking link.", tenant);
        await sendLinksViaSMS(fromNumber, toNumber, [tenant.booking.consultation_url], tenant, 'consultation_booking');
      } else {
        await respondWithNaturalVoice(response, "For pricing information, please give us a call or visit our website.", tenant);
        if (tenant?.contact?.website) {
          await sendLinksViaSMS(fromNumber, toNumber, [tenant.contact.website], tenant, 'website');
        }
      }
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      handled = true;
    }

    // General appointment management (existing appointments only)
    if (!handled) {
      let requestType = 'lookup';
      
      if (lowerSpeech.includes('what time') || 
          lowerSpeech.includes('when is') ||
          lowerSpeech.includes('appointment time')) {
        requestType = 'time';
      } else if (lowerSpeech.includes('manage')) {
        requestType = 'manage';
      } else if (lowerSpeech.includes('cancel')) {
        requestType = 'cancel';
      } else if (lowerSpeech.includes('reschedule')) {
        requestType = 'reschedule';
      }

      if (lowerSpeech.includes('appointment') && 
          (lowerSpeech.includes('cancel') || lowerSpeech.includes('reschedule') ||
           lowerSpeech.includes('manage') || lowerSpeech.includes('time') ||
           lowerSpeech.includes('when') || lowerSpeech.includes('check'))) {
        
        const appointmentResult = await callAirtableAPI(tenant, 'lookup_appointments', {
          phone: fromNumber
        }, requestType);
        
        if (appointmentResult.handled) {
          await respondWithNaturalVoice(response, appointmentResult.speech, tenant);
          handled = true;
          
          // Send appointment lookup link for management requests
          if (appointmentResult.data?.sendConfirmation) {
            const appointmentLookupUrl = tenant?.contact?.appointment_lookup || 
                                       tenant?.appointment_lookup_url ||
                                       "https://www.example.com/appointment-lookup";
            await sendLinksViaSMS(fromNumber, toNumber, [appointmentLookupUrl], tenant, 'appointment_lookup');
          }
          
          response.gather({
            input: "speech",
            action: "/handle-speech",
            method: "POST",
            timeout: 12,
            speechTimeout: "auto"
          });
          await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
        }
      }
    }

    // Continue conversation with FIXED flow control
    if (handled) {
      // Only hang up for explicit goodbye phrases
      if (lowerSpeech.includes('bye') || lowerSpeech.includes('goodbye') || 
          lowerSpeech.includes('that\'s all') || lowerSpeech.includes('that is all') ||
          lowerSpeech.includes('nothing else') || lowerSpeech.includes('no more') ||
          lowerSpeech.includes('i\'m done') || lowerSpeech.includes('im done') ||
          lowerSpeech.includes('have a good day') || lowerSpeech.includes('talk to you later') ||
          (lowerSpeech.includes('no') && (lowerSpeech.includes('thank') || lowerSpeech.includes('good')))) {
        await respondWithNaturalVoice(response, "You're welcome! Have a great day!", tenant);
        response.hangup();
      } else if (lowerSpeech.includes('no') && lowerSpeech.length <= 15 && 
                 !lowerSpeech.includes('english') && !lowerSpeech.includes('problem')) {
        await respondWithNaturalVoice(response, "Looks like you're all set! Feel free to call back anytime if you need help. Have a great day!", tenant);
        response.hangup();
      }
    } else {
      // If not handled, use OpenAI with tenant-specific prompts
      const knowledgeText = loadKnowledgeFor(tenant);
      const systemPrompt = buildVoicePrompt(tenant, knowledgeText);

      const completion = await openai.chat.completions.create({
        model: tenant?.voice_config?.model || tenant?.model || "gpt-4o-mini",
        temperature: tenant?.voice_config?.temperature || tenant?.temperature || 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: speechResult }
        ],
        max_tokens: 100
      });

      const aiResponse = completion.choices?.[0]?.message?.content?.trim() || 
        "I'm sorry, I couldn't process that right now.";
      
      // Check for URLs in the AI response and send via SMS if configured
      const urls = extractUrls(aiResponse);
      if (urls.length > 0) {
        await sendLinksViaSMS(fromNumber, toNumber, urls, tenant, 'general');
        const cleanResponse = aiResponse.replace(/(https?:\/\/[^\s]+)/g, '').trim();
        await respondWithNaturalVoice(response, `${cleanResponse} I'm texting you the link now.`, tenant);
      } else {
        await respondWithNaturalVoice(response, aiResponse, tenant);
      }

      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });

      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
    }

  } catch (err) {
    fastify.log.error({ err }, "Speech processing error");
    await respondWithNaturalVoice(response, "I'm having a technical issue. Let me try again - what did you need help with?", tenant);
    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 10,
      speechTimeout: "auto"
    });
    await respondWithNaturalVoice(response, "I'm listening.", tenant);
  }

  reply.type("text/xml").send(response.toString());
});

// ---------------- START SERVER ----------------
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 LocSync Voice Bot - Multi-Tenant Edition running on ${address}`);
  console.log(`📞 Configured tenants: ${Object.keys(TENANTS).join(", ")}`);
  console.log(`🎤 Voice: Twilio TTS (Polly.Joanna-Neural)`);
  console.log(`✨ Simple, reliable, and professional!`);
});
