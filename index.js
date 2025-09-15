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

// ENHANCED SMS function with service-specific messaging and maintenance booking links
async function sendLinksViaSMS(fromNumber, toNumber, links, tenant, serviceType = null) {
  if (!links.length || !tenant?.voice_config?.send_links_via_sms) return;
  
  try {
    let message = "";
    
    if (links.length === 1) {
      const link = links[0];
      
      // Service-specific messaging
      if (serviceType === 'service_portal') {
        message = `Service Portal - Get personalized quotes: ${link}`;
      } else if (serviceType === 'consultation') {
        message = `Book your consultation appointment: ${link}`;
      } else if (serviceType === 'retwist_booking') {
        message = `Book your Retwist maintenance appointment: ${link}`;
      } else if (serviceType === 'wick_booking') {
        message = `Book your Wick Loc maintenance appointment: ${link}`;
      } else if (serviceType === 'interlock_booking') {
        message = `Book your Interlock maintenance appointment: ${link}`;
      } else if (serviceType === 'sisterlock_booking') {
        message = `Book your Sisterlock maintenance appointment: ${link}`;
      } else if (serviceType === 'crochet_booking') {
        message = `Book your Crochet maintenance appointment: ${link}`;
      } else if (serviceType === 'bald_coverage_booking') {
        message = `Book your Bald Coverage maintenance appointment: ${link}`;
      } else if (serviceType === 'retwist_quote') {
        message = `Retwist Quote Form: ${link}`;
      } else if (serviceType === 'bald_coverage_quote') {
        message = `Bald Coverage Quote Form: ${link}`;
      } else if (serviceType === 'repair_quote') {
        message = `Loc Repair Quote Form: ${link}`;
      } else if (serviceType === 'extensions_quote') {
        message = `Loc Extensions Quote Form: ${link}`;
      } else if (serviceType === 'starter_quote') {
        message = `Starter Locs Quote Form: ${link}`;
      } else if (serviceType === 'directions') {
        message = `Directions to our salon: ${link}`;
      } else if (serviceType === 'appointment_lookup') {
        message = `Manage your appointments: ${link}`;
      } else {
        message = `Here's the link: ${link}`;
      }
    } else {
      message = `Here are your links:\n${links.map((link, i) => `${i + 1}. ${link}`).join('\n')}`;
    }
    
    await twilioClient.messages.create({
      body: message,
      from: toNumber,
      to: fromNumber
    });
    
    fastify.log.info({ 
      fromNumber, 
      linkCount: links.length, 
      serviceType 
    }, "SMS sent successfully");
    
  } catch (err) {
    fastify.log.error({ err, fromNumber, serviceType }, "Failed to send SMS");
  }
}

// Function to get service quote link
function getServiceQuoteLink(serviceType, tenant) {
  const quoteLinks = {
    'retwist': tenant?.services?.quote_urls?.retwist || tenant?.quote_system?.urls?.retwist,
    'bald_coverage': tenant?.services?.quote_urls?.bald_coverage || tenant?.quote_system?.urls?.bald_coverage,
    'repair': tenant?.services?.quote_urls?.repair || tenant?.quote_system?.urls?.repair,
    'extensions': tenant?.services?.quote_urls?.extensions || tenant?.quote_system?.urls?.extensions,
    'wick': tenant?.services?.quote_urls?.wick_maintenance || tenant?.quote_system?.urls?.wick_maintenance,
    'starter': tenant?.services?.quote_urls?.starter_locs || tenant?.quote_system?.urls?.starter_locs,
    'interlock': tenant?.services?.quote_urls?.interlock || tenant?.quote_system?.urls?.interlock,
    'sisterlocks': tenant?.services?.quote_urls?.microlocs || tenant?.quote_system?.urls?.microlocs,
    'crochet': tenant?.services?.quote_urls?.crochet || tenant?.quote_system?.urls?.crochet
  };
  
  return quoteLinks[serviceType] || tenant?.service_portal?.url || tenant?.booking?.main_url;
}

// Function to get maintenance booking link
function getMaintenanceBookingLink(serviceType, tenant) {
  const bookingLinks = {
    'retwist': tenant?.booking?.maintenance_links?.retwist || tenant?.maintenance_booking_links?.links?.retwist,
    'wick': tenant?.booking?.maintenance_links?.wick || tenant?.maintenance_booking_links?.links?.wick,
    'interlock': tenant?.booking?.maintenance_links?.interlock || tenant?.maintenance_booking_links?.links?.interlock,
    'sisterlock': tenant?.booking?.maintenance_links?.sisterlock || tenant?.maintenance_booking_links?.links?.sisterlock,
    'crochet': tenant?.booking?.maintenance_links?.crochet || tenant?.maintenance_booking_links?.links?.crochet,
    'bald_coverage': tenant?.booking?.maintenance_links?.bald_coverage || tenant?.maintenance_booking_links?.links?.bald_coverage
  };
  
  return bookingLinks[serviceType] || tenant?.booking?.main_url;
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

// STRUCTURED voice prompt builder
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
  
  const bookingUrl = t.booking?.main_url || t.booking_url || "our online booking system";
  const bookingSite = t.booking?.booking_site || t.booking?.square_site || t.square_site || "";
  const depositInfo = t.policies?.deposits ? "Deposits required for appointments" : "Deposits may be required";
  const cancellationPolicy = t.policies?.cancellation ? "Please check our cancellation policy" : "Please call to cancel";
  
  const canonicalQA = (t.canonical_answers || [])
    .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`)
    .join("\n") || "(none)";

  let prompt = `You are the virtual receptionist for "${t.studio_name || 'our salon'}" with ${loctician}${experience ? ` (${experience})` : ""}.

CRITICAL INSTRUCTIONS:
- Keep responses under 15 seconds
- Never spell out URLs - just say "visit our website" or "check our portal"
- DO NOT repeat or rephrase the customer's question back to them
- Answer directly and naturally
- Be conversational and helpful
- Use the STRUCTURED FLOW for all interactions
- Always offer to text helpful links and directions
- When providing address, always say the full street address clearly
- For non-English speakers, offer callback options or texting for translation help
- When texting links, always mention what type of link you're sending

STRUCTURED CONVERSATION FLOW:
Main Menu Options:
1. APPOINTMENTS - For scheduling new appointments or managing existing ones
2. CONSULTATION - For quotes and in-person consultations  
3. SALON INFO - For pricing, services, directions, policies, etc.
4. LOC CARE TIPS - For hair care advice and maintenance tips

APPOINTMENT FLOW:
- Ask: "Are you a new or returning client?"
- NEW CLIENT: Ask about service interest, then send appropriate quote link
- RETURNING CLIENT: Ask "new appointment or manage existing?" then route accordingly

CONSULTATION FLOW:  
- Ask: "In-person visit or immediate 24/7 quote?"
- Route to consultation booking or service quote accordingly

SALON INFO FLOW:
- Offer: "You can ask about pricing, services, directions, availability, refunds, deposits, gallery, terms, training, or financing"
- Answer questions directly and send links when helpful

LOC CARE FLOW:
- Ask: "Recent install, recent repair, or something else?"
- Provide targeted advice based on their situation

Salon Information:
- Name: ${t.studio_name || 'The Salon'}
- Loctician: ${loctician}${experience ? ` - ${experience}` : ""}
- Hours: ${hours}
- Services: ${services || "Hair care services"}
${specialties ? `- Specialties: ${specialties}` : ""}
${address}

Booking & Policies:
- Booking: ${bookingUrl}
${bookingSite ? `- Booking Site: ${bookingSite}` : ""}
- Deposits: ${depositInfo}
- Cancellations: ${cancellationPolicy}

${website ? `Website: ${website}` : ""}
${instagram ? `Instagram: ${instagram}` : ""}

Canonical Q&A (use these exact responses):
${canonicalQA}

Knowledge Base:
${(knowledgeText || "").slice(0, 8000)}

Remember: Guide conversations using the structured flow but allow natural interruptions. Be conversational, direct, and never spell out web addresses. Always follow up with "Is there anything else I can help you with?"`;

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
        speech: `You have an appointment for ${next.service} on ${dateInfo}${timeInfo}. I'm texting you the link to manage it.`,
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
        speech: `You have ${upcoming.length} appointments: ${allAppts.join(', ')}. Which appointment would you like to manage? I'm texting you the link to help manage them.`,
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
    service: "LocSync Voice Agent - Structured Flow",
    tenants: Object.keys(TENANTS).length 
  };
});

fastify.get("/health", async () => {
  return { status: "healthy", timestamp: new Date().toISOString() };
});

// Incoming call handler with structured greeting
fastify.post("/incoming-call", async (req, reply) => {
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({ to: toNumber, from: fromNumber, tenant: tenant?.tenant_id }, "Incoming call - structured flow");

  const response = new twiml();
  const greeting = tenant?.voice_config?.greeting_tts || 
    `Thanks for calling ${tenant?.studio_name || "our salon"}. You can say things like: Appointment, Consultation, Salon Info, or Loc Care. What would you like me to help you with?`;

  response.say(greeting);
  response.gather({
    input: "speech",
    action: "/handle-speech",
    method: "POST",
    timeout: 10,
    speechTimeout: "auto"
  });

  reply.type("text/xml").send(response.toString());
});
// ========== RETURNING CLIENT SUB-FLOWS ==========
// Handle speech input - STRUCTURED FLOW VERSION
fastify.post("/handle-speech", async (req, reply) => {
  const speechResult = req.body?.SpeechResult?.trim() || "";
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({ 
    speech: speechResult, 
    tenant: tenant?.tenant_id
  }, "Processing speech with structured flow");

  const response = new twiml();

  if (!speechResult) {
    response.say("I didn't catch that clearly. You can say Appointment, Consultation, Salon Info, or Loc Care. What would you like help with?");
    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 10,
      speechTimeout: "auto"
    });
    reply.type("text/xml").send(response.toString());
    return;
  }

  try {
    const lowerSpeech = speechResult.toLowerCase();
    let handled = false;

    fastify.log.info({ lowerSpeech }, "Structured flow processing");

    // ========== MAIN FLOW PATHS ==========

    // 1. APPOINTMENTS FLOW
    if (!handled && (lowerSpeech.includes('appointment') || lowerSpeech.includes('book') || 
                     lowerSpeech.includes('schedule') || lowerSpeech.includes('need an appointment'))) {
      fastify.log.info("APPOINTMENTS flow triggered");
      response.say("Are you a new or returning client?");
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      handled = true;
    }

    // 2. CONSULTATION FLOW
    else if (!handled && (lowerSpeech.includes('consultation') || lowerSpeech.includes('consult'))) {
      fastify.log.info("CONSULTATION flow triggered");
      response.say("Would you like an in-person visit or an immediate 24/7 quote?");
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      handled = true;
    }

    // 3. SALON INFO FLOW
    else if (!handled && (lowerSpeech.includes('salon info') || lowerSpeech.includes('information') ||
                          lowerSpeech.includes('about') || lowerSpeech.includes('details'))) {
      fastify.log.info("SALON INFO flow triggered");
      response.say("You can ask about pricing, services, directions, availability, refunds, deposits, gallery, terms, training, or financing. What would you like to know?");
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      handled = true;
    }

    // 4. LOC CARE TIPS FLOW
    else if (!handled && (lowerSpeech.includes('loc care') || lowerSpeech.includes('hair care') ||
                          lowerSpeech.includes('care tips') || lowerSpeech.includes('advice'))) {
      fastify.log.info("LOC CARE flow triggered");
      response.say("Are you asking about a recent install, recent repair, or something else?");
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      handled = true;
    }

    // ========== APPOINTMENT SUB-FLOWS ==========

    // NEW CLIENT APPOINTMENT FLOW
    else if (!handled && (lowerSpeech.includes('new client') || lowerSpeech.includes('new customer') || 
                          lowerSpeech.includes('first time') || (lowerSpeech.includes('new') && !lowerSpeech.includes('returning')))) {
      fastify.log.info("NEW CLIENT appointment sub-flow");
      response.say("What service are you interested in? You can say loc repair, retwist, bald coverage, extensions, or if you're not sure, just say I don't know.");
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      handled = true;
    }

    // RETURNING CLIENT APPOINTMENT FLOW  
    else if (!handled && (lowerSpeech.includes('returning client') || lowerSpeech.includes('return client') ||
                          lowerSpeech.includes('existing client') || lowerSpeech.includes('been here before') ||
                          (lowerSpeech.includes('returning') && !lowerSpeech.includes('new')))) {
      fastify.log.info("RETURNING CLIENT appointment sub-flow");
      response.say("Do you need a new appointment or do you want to manage an existing appointment?");
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      handled = true;
    }

    // ========== NEW CLIENT SERVICE SELECTION ==========
    else if (!handled && (lowerSpeech.includes("i don't know") || lowerSpeech.includes("not sure") || 
                          lowerSpeech.includes("don't know") || lowerSpeech.includes("unsure"))) {
      fastify.log.info("NEW CLIENT - doesn't know service");
      response.say("No problem, let's get you to our Service Portal that asks a few basic questions and automatically sends you to the proper quote form. Sending link now.");
      const servicePortalLink = tenant?.service_portal?.url || tenant?.booking?.main_url;
      if (servicePortalLink) await sendLinksViaSMS(fromNumber, toNumber, [servicePortalLink], tenant, 'service_portal');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    // NEW CLIENT - SPECIFIC SERVICE QUOTE REQUESTS
    else if (!handled && (lowerSpeech.includes('loc repair') || lowerSpeech.includes('repair'))) {
      fastify.log.info("NEW CLIENT - loc repair quote");
      response.say("Sending you the loc repair quote link now.");
      const repairQuoteLink = getServiceQuoteLink('repair', tenant);
      if (repairQuoteLink) await sendLinksViaSMS(fromNumber, toNumber, [repairQuoteLink], tenant, 'repair_quote');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    else if (!handled && lowerSpeech.includes('retwist')) {
      fastify.log.info("NEW CLIENT - retwist quote");
      response.say("Sending you the retwist quote link now.");
      const retwistQuoteLink = getServiceQuoteLink('retwist', tenant);
      if (retwistQuoteLink) await sendLinksViaSMS(fromNumber, toNumber, [retwistQuoteLink], tenant, 'retwist_quote');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    else if (!handled && (lowerSpeech.includes('bald coverage') || lowerSpeech.includes('bald spot'))) {
      fastify.log.info("NEW CLIENT - bald coverage quote");
      response.say("Sending you the bald coverage quote link now.");
      const baldQuoteLink = getServiceQuoteLink('bald_coverage', tenant);
      if (baldQuoteLink) await sendLinksViaSMS(fromNumber, toNumber, [baldQuoteLink], tenant, 'bald_coverage_quote');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    else if (!handled && (lowerSpeech.includes('extensions') || lowerSpeech.includes('extension'))) {
      fastify.log.info("NEW CLIENT - extensions quote");
      response.say("Sending you the extensions quote link now.");
      const extensionsQuoteLink = getServiceQuoteLink('extensions', tenant);
      if (extensionsQuoteLink) await sendLinksViaSMS(fromNumber, toNumber, [extensionsQuoteLink], tenant, 'extensions_quote');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    // RETURNING CLIENT - NEW APPOINTMENT
    else if (!handled && (lowerSpeech.includes('new appointment') || lowerSpeech.includes('new appt') ||
                          (lowerSpeech.includes('new') && lowerSpeech.includes('appointment')))) {
      fastify.log.info("RETURNING CLIENT - new appointment");
      response.say("Which service do you usually get? Say retwist, wick maintenance, interlock, sisterlocks, crochet, or bald coverage.");
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      handled = true;
    }

    // RETURNING CLIENT - MANAGE EXISTING APPOINTMENT
    else if (!handled && (lowerSpeech.includes('manage') || lowerSpeech.includes('existing') || 
                          lowerSpeech.includes('change') || lowerSpeech.includes('cancel') || lowerSpeech.includes('reschedule'))) {
      fastify.log.info("RETURNING CLIENT - manage existing appointment");
      
      const appointmentResult = await callAirtableAPI(tenant, 'lookup_appointments', {
        phone: fromNumber
      }, 'manage');
      
      if (appointmentResult.handled) {
        response.say(appointmentResult.speech);
        
        if (appointmentResult.data?.sendConfirmation) {
          const appointmentLookupUrl = tenant?.contact?.appointment_lookup || "";
          if (appointmentLookupUrl) await sendLinksViaSMS(fromNumber, toNumber, [appointmentLookupUrl], tenant, 'appointment_lookup');
        }
        
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        response.say("Is there anything else I can help you with?");
        handled = true;
      }
    }

    // RETURNING CLIENT - SERVICE BOOKING SELECTIONS
    else if (!handled && lowerSpeech.includes('retwist')) {
      fastify.log.info("RETURNING CLIENT - retwist booking");
      response.say("Sending you the direct booking link for your retwist maintenance appointment now.");
      const bookingLink = getMaintenanceBookingLink('retwist', tenant);
      if (bookingLink) await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'retwist_booking');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    else if (!handled && lowerSpeech.includes('wick')) {
      fastify.log.info("RETURNING CLIENT - wick booking");
      response.say("Sending you the direct booking link for your wick loc maintenance appointment now.");
      const bookingLink = getMaintenanceBookingLink('wick', tenant);
      if (bookingLink) await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'wick_booking');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    else if (!handled && lowerSpeech.includes('interlock')) {
      fastify.log.info("RETURNING CLIENT - interlock booking");
      response.say("Sending you the direct booking link for your interlock maintenance appointment now.");
      const bookingLink = getMaintenanceBookingLink('interlock', tenant);
      if (bookingLink) await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'interlock_booking');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    else if (!handled && (lowerSpeech.includes('sisterlock') || lowerSpeech.includes('microlock'))) {
      fastify.log.info("RETURNING CLIENT - sisterlock booking");
      response.say("Sending you the direct booking link for your sisterlock maintenance appointment now.");
      const bookingLink = getMaintenanceBookingLink('sisterlock', tenant);
      if (bookingLink) await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'sisterlock_booking');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    else if (!handled && lowerSpeech.includes('crochet')) {
      fastify.log.info("RETURNING CLIENT - crochet booking");
      response.say("Sending you the direct booking link for your crochet maintenance appointment now.");
      const bookingLink = getMaintenanceBookingLink('crochet', tenant);
      if (bookingLink) await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'crochet_booking');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    else if (!handled && lowerSpeech.includes('bald coverage')) {
      fastify.log.info("RETURNING CLIENT - bald coverage booking");
      response.say("Sending you the direct booking link for your bald coverage maintenance appointment now.");
      const bookingLink = getMaintenanceBookingLink('bald_coverage', tenant);
      if (bookingLink) await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'bald_coverage_booking');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    // ========== CONSULTATION SUB-FLOWS ==========

    // CONSULTATION - IN-PERSON VISIT
    else if (!handled && (lowerSpeech.includes('in-person') || lowerSpeech.includes('visit') || 
                          lowerSpeech.includes('in person'))) {
      fastify.log.info("CONSULTATION - in-person visit");
      response.say("Sending you the consultation booking link now.");
      const consultationLink = tenant?.booking?.consultation_url;
      if (consultationLink) await sendLinksViaSMS(fromNumber, toNumber, [consultationLink], tenant, 'consultation');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    // CONSULTATION - IMMEDIATE QUOTE
    else if (!handled && (lowerSpeech.includes('immediate') || lowerSpeech.includes('quote') || 
                          lowerSpeech.includes('24/7') || lowerSpeech.includes('online'))) {
      fastify.log.info("CONSULTATION - immediate quote");
      response.say("Which service are you interested in? You can say loc repair, retwist, bald coverage, extensions, or if you're not sure, just say I don't know.");
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      handled = true;
    }

    // ========== SALON INFO SUB-FLOWS ==========

    // DIRECTIONS
    else if (!handled && (lowerSpeech.includes('direction') || lowerSpeech.includes('address') || 
                          lowerSpeech.includes('location') || lowerSpeech.includes('where'))) {
      fastify.log.info("SALON INFO - directions");
      response.say(`We're located at ${tenant?.address || '25240 Lahser Road, Suite 9, Southfield, Michigan 48033'}. I'm texting you detailed directions now.`);
      const directionLinks = [tenant?.contact?.directions_url || ""];
      if (directionLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, directionLinks, tenant, 'directions');
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    // HOURS
    else if (!handled && (lowerSpeech.includes('hours') || lowerSpeech.includes('open') || lowerSpeech.includes('close'))) {
      fastify.log.info("SALON INFO - hours");
      response.say(`We're ${tenant?.hours?.hours_string || 'open Sunday through Friday, 11 AM to 7 PM'} by appointment only. We're closed Saturdays.`);
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
      handled = true;
    }

    // Log final handling status
    fastify.log.info({ handled, lowerSpeech }, "Structured flow processing complete");

    // Continue conversation with flow control
    if (handled) {
      // Only hang up for explicit goodbye phrases
      if (lowerSpeech.includes('bye') || lowerSpeech.includes('goodbye') || 
          lowerSpeech.includes('that\'s all') || lowerSpeech.includes('nothing else') ||
          lowerSpeech.includes('no more') || lowerSpeech.includes('i\'m done') ||
          (lowerSpeech.includes('no') && (lowerSpeech.includes('thank') || lowerSpeech.includes('good')))) {
        response.say("You're welcome! Have a great day!");
        response.hangup();
      } else if (lowerSpeech.includes('no') && lowerSpeech.length <= 15 && 
                 !lowerSpeech.includes('english') && !lowerSpeech.includes('problem')) {
        response.say("Looks like you're all set! Feel free to call back anytime if you need help. Have a great day!");
        response.hangup();
      }
    } else {
      // If not handled by structured flow, use OpenAI fallback
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
        "I'm sorry, I couldn't process that right now. You can say Appointment, Consultation, Salon Info, or Loc Care. What would you like help with?";
      
      response.say(aiResponse);
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      response.say("Is there anything else I can help you with?");
    }

  } catch (err) {
    fastify.log.error({ err }, "Speech processing error in structured flow");
    response.say("I'm having a technical issue. You can say Appointment, Consultation, Salon Info, or Loc Care. What would you like help with?");
    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 10,
      speechTimeout: "auto"
    });
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
      response.message("Thanks for texting! Call us for assistance with appointments, consultations, salon info, or loc care tips.");
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
    has_detailed_config: !!TENANT_DETAILS.has(req.params.tenantId),
    advanced_features: fullTenant?.advanced_features || {},
    flow_type: "structured"
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
  console.log(`🚀 LocSync Voice Bot - Structured Flow running on ${address}`);
  console.log(`📞 Configured tenants: ${Object.keys(TENANTS).join(", ")}`);
});
