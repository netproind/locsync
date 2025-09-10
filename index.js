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
      
      // ONLY use advanced service messaging if tenant has advanced features enabled
      if (tenant?.advanced_features?.service_portal && serviceType === 'wick_maintenance') {
        message = `Wick Locs Maintenance Quote: ${link}`;
      } else if (tenant?.advanced_features?.bald_coverage && serviceType === 'bald_coverage') {
        message = `Bald Coverage Quote: ${link}`;
      } else if (tenant?.advanced_features?.loc_repair && serviceType === 'repair') {
        message = `Loc Repair Quote: ${link}`;
      } else if (serviceType === 'starter_locs') {
        message = `Starter Locs Quote: ${link}`;
      } else if (tenant?.advanced_features?.service_portal && serviceType === 'sisterlocks') {
        message = `Sisterlocks Maintenance Quote: ${link}`;
      } else if (tenant?.advanced_features?.service_portal && serviceType === 'service_portal') {
        message = `Service Portal - Get personalized quotes: ${link}`;
      } else if (serviceType === 'website') {
        message = `Visit our website for language support chatbot: ${link}`;
      } else if (serviceType === 'instagram') {
        message = `Follow us on Instagram: ${link}`;
      } else if (serviceType === 'appointment_lookup') {
        message = `Appointment Lookup - Find and manage your appointments: ${link}`;
      } else if (tenant?.advanced_features?.maintenance_booking_links && serviceType === 'retwist_booking') {
        message = `Book your Retwist/Palm Roll maintenance appointment: ${link}`;
      } else if (tenant?.advanced_features?.wick_locs && serviceType === 'wick_booking') {
        message = `Book your Wick Loc maintenance appointment: ${link}`;
      } else if (tenant?.advanced_features?.maintenance_booking_links && serviceType === 'interlock_booking') {
        message = `Book your Interlock maintenance appointment: ${link}`;
      } else if (tenant?.advanced_features?.maintenance_booking_links && serviceType === 'sisterlock_booking') {
        message = `Book your Sisterlock/Microlock maintenance appointment: ${link}`;
      } else if (tenant?.advanced_features?.maintenance_booking_links && serviceType === 'crochet_booking') {
        message = `Book your Crochet Roots maintenance appointment: ${link}`;
      } else if (tenant?.advanced_features?.bald_coverage && serviceType === 'bald_coverage_booking') {
        message = `Book your Bald Coverage maintenance appointment: ${link}`;
      } else if (link.includes('directions')) {
        message = `Here are the detailed directions to our door: ${link}`;
      } else {
        message = `Here's the link we mentioned: ${link}`;
      }
    } else {
      message = `Here are the links we mentioned:\n${links.map((link, i) => {
        if (link.includes('service_portal')) return `${i + 1}. Service Portal: ${link}`;
        if (link.includes('directions')) return `${i + 1}. Directions: ${link}`;
        if (link.includes('instagram')) return `${i + 1}. Instagram: ${link}`;
        if (link.includes('appointment-lookup')) return `${i + 1}. Appointment Lookup: ${link}`;
        if (link.includes(tenant?.base_domain || 'website')) return `${i + 1}. Website (Language Support): ${link}`;
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
      messageType: 'service_quote' 
    }, "SMS with service quote sent successfully");
    
  } catch (err) {
    fastify.log.error({ err, fromNumber, serviceType }, "Failed to send SMS with service quote");
  }
}

// Function to get maintenance booking link based on service type
function getMaintenanceBookingLink(serviceType, tenant) {
  // ONLY return advanced booking links if tenant has maintenance_booking_links enabled
  if (!tenant?.advanced_features?.maintenance_booking_links) {
    return tenant?.booking?.main_url || tenant?.booking_url || tenant?.contact?.website || '#';
  }
  
  const baseLinks = {
    'retwist': tenant?.maintenance_booking_links?.links?.retwist || tenant?.booking?.maintenance_links?.retwist,
    'wick': tenant?.maintenance_booking_links?.links?.wick || tenant?.booking?.maintenance_links?.wick,
    'interlock': tenant?.maintenance_booking_links?.links?.interlock || tenant?.booking?.maintenance_links?.interlock,
    'sisterlock': tenant?.maintenance_booking_links?.links?.sisterlock || tenant?.booking?.maintenance_links?.sisterlock,
    'crochet': tenant?.maintenance_booking_links?.links?.crochet || tenant?.booking?.maintenance_links?.crochet,
    'bald_coverage': tenant?.maintenance_booking_links?.links?.bald_coverage || tenant?.booking?.maintenance_links?.bald_coverage
  };
  
  return baseLinks[serviceType] || tenant?.booking?.main_url || tenant?.booking_url || '#';
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

// CONDITIONAL voice prompt builder - Only adds advanced features if enabled
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
- Be conversational and helpful`;

  // CONDITIONAL: Only add new vs returning flow if enabled
  if (t.advanced_features?.new_vs_returning_flow) {
    prompt += `
- For ALL appointment requests, ALWAYS ask "Are you a new client or a returning client?" first
- NEW CLIENTS: Send to service portal for quotes
- RETURNING CLIENTS: Ask what service they usually get, then provide direct booking link`;
  } else {
    prompt += `
- For appointment requests, direct to main booking system or consultation`;
  }

  prompt += `
- Never tell someone to just "visit our online system" and hang up
- Address payment security concerns by mentioning in-person deposit options
- Always offer to text helpful links and directions`;

  // CONDITIONAL: Only add loctician-specific running late message if this salon has it
  if (t.custom_responses?.running_late) {
    prompt += `
- Acknowledge when clients are running late and inform them ${loctician} is notified`;
  }

  prompt += `
- When providing address, always say the full street address clearly
- For non-English speakers, offer callback options or texting for translation help
- When texting links, always mention what type of link you're sending`;

  // CONDITIONAL: Only add advanced booking flow if enabled
  if (t.advanced_features?.new_vs_returning_flow && t.advanced_features?.maintenance_booking_links) {
    prompt += `

ADVANCED APPOINTMENT BOOKING FLOW:
When someone requests an appointment:
1. ALWAYS ask: "Are you a new client or a returning client?"
2. NEW CLIENT: Send service portal link via SMS
3. RETURNING CLIENT: Ask "What service do you usually get?" then send appropriate maintenance booking link:
   - Retwist/Palm Roll → Direct booking link
   - Wick Loc Maintenance → Direct booking link  
   - Interlock Maintenance → Direct booking link
   - Sisterlock/Microlock → Direct booking link
   - Crochet Roots → Direct booking link
   - Bald Coverage → Direct booking link`;
  } else {
    prompt += `

BASIC APPOINTMENT BOOKING:
When someone requests an appointment, direct them to the main booking system or consultation.`;
  }

  prompt += `

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

Remember: Be conversational, direct, and never spell out web addresses. Answer questions directly without repeating them.`;

  // CONDITIONAL: Only add if advanced flow enabled
  if (t.advanced_features?.new_vs_returning_flow) {
    prompt += ` ALWAYS ask new vs returning for ALL appointment requests.`;
  }

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
    timeout: 10,
    speechTimeout: "auto"
  });

  reply.type("text/xml").send(response.toString());
});
// Handle speech input - CONDITIONAL advanced features (NO DUPLICATES)
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
    response.say("I didn't catch that clearly. Could you please repeat what you need? I'm still here to help.");
    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 10,
      speechTimeout: "auto"
    });
    response.say("I'm waiting for your response.");
    reply.type("text/xml").send(response.toString());
    return;
  }

  try {
    const lowerSpeech = speechResult.toLowerCase();
    let handled = false;

    // Enhanced multilingual support - CONDITIONAL
    if (tenant?.advanced_features?.multilingual_support) {
      if (lowerSpeech.includes('español') || lowerSpeech.includes('spanish') || 
          lowerSpeech.includes('habla español') || lowerSpeech.includes('hablas español') ||
          lowerSpeech.includes('en español') || lowerSpeech.includes('no hablo inglés') ||
          lowerSpeech.includes('no hablo ingles')) {
        response.say("Para soporte en español, puede usar nuestro chat bot en nuestro sitio web. Está en la esquina inferior derecha. Le envío el enlace por mensaje de texto ahora.");
        const websiteLinks = [tenant?.contact?.website || tenant?.website || ""];
        if (websiteLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant, 'website');
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        response.say("¿Hay algo más en que pueda ayudarle?");
        handled = true;
      }
      else if (lowerSpeech.includes('french') || lowerSpeech.includes('français') ||
               lowerSpeech.includes('parlez français') || lowerSpeech.includes('en français') ||
               lowerSpeech.includes('parlez-vous français') || lowerSpeech.includes('je ne parle pas anglais')) {
        response.say("Pour le support en français, vous pouvez utiliser notre chat bot sur notre site web. Il est dans le coin inférieur droit. Je vous envoie le lien par SMS maintenant.");
        const websiteLinks = [tenant?.contact?.website || tenant?.website || ""];
        if (websiteLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant, 'website');
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        response.say("Y a-t-il autre chose que je puisse faire pour vous?");
        handled = true;
      }
      else if (lowerSpeech.includes('german') || lowerSpeech.includes('deutsch') ||
               lowerSpeech.includes('sprechen sie deutsch') || lowerSpeech.includes('auf deutsch') ||
               lowerSpeech.includes('ich spreche kein englisch')) {
        response.say("Für deutsche Unterstützung können Sie unseren Chat-Bot auf unserer Website verwenden. Er befindet sich in der unteren rechten Ecke. Ich sende Ihnen jetzt den Link per SMS.");
        const websiteLinks = [tenant?.contact?.website || tenant?.website || ""];
        if (websiteLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant, 'website');
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        response.say("Gibt es noch etwas, womit ich Ihnen helfen kann?");
        handled = true;
      }
      else if (lowerSpeech.includes('arabic') || lowerSpeech.includes('عربي') ||
               lowerSpeech.includes('تتكلم عربي') || lowerSpeech.includes('العربية')) {
        response.say("للدعم باللغة العربية، يمكنك استخدام روبوت الدردشة على موقعنا الإلكتروني في الزاوية اليمنى السفلى. سأرسل لك الرابط عبر رسالة نصية الآن.");
        const websiteLinks = [tenant?.contact?.website || tenant?.website || ""];
        if (websiteLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant, 'website');
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        response.say("هل هناك شيء آخر يمكنني مساعدتك فيه؟");
        handled = true;
      }
      else if (lowerSpeech.includes('no english') || lowerSpeech.includes("don't speak english") ||
               lowerSpeech.includes('other language') || lowerSpeech.includes('translate')) {
        response.say("For language support, please use our chat bot on our website in the bottom right corner. I'm texting you the link now where you can get help in your language.");
        const websiteLinks = [tenant?.contact?.website || tenant?.website || ""];
        if (websiteLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant, 'website');
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
    
    // Website/Instagram requests
    else if (lowerSpeech.includes('website') || lowerSpeech.includes('web site') ||
             lowerSpeech.includes('online') || lowerSpeech.includes('url')) {
      response.say("I'm texting you our website link now so you can easily access it.");
      const websiteLinks = [tenant?.contact?.website || tenant?.website || ""];
      if (websiteLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant, 'website');
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
    
    else if (lowerSpeech.includes('instagram') || lowerSpeech.includes('insta') ||
             lowerSpeech.includes('social media')) {
      response.say("I'm texting you our Instagram link now.");
      const instaLinks = [tenant?.contact?.instagram_url || ""];
      if (instaLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, instaLinks, tenant, 'instagram');
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
    
    // CONDITIONAL APPOINTMENT BOOKING FLOW - Only for advanced tenants
    else if (lowerSpeech.includes('need an appointment') || lowerSpeech.includes('need appointment') ||
             lowerSpeech.includes('want an appointment') || lowerSpeech.includes('want appointment') ||
             lowerSpeech.includes('book an appointment') || lowerSpeech.includes('book appointment') ||
             lowerSpeech.includes('schedule an appointment') || lowerSpeech.includes('schedule appointment') ||
             lowerSpeech.includes('looking for slot') || lowerSpeech.includes('slot availability') ||
             lowerSpeech.includes('slots available') || lowerSpeech.includes('availability')) {
      
      if (tenant?.advanced_features?.new_vs_returning_flow) {
        // ADVANCED: Always ask new vs returning
        response.say("Are you a new client or a returning client?");
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        response.say("Please let me know if you're new or returning so I can help you book the right way.");
        handled = true;
      } else {
        // BASIC: Direct to main booking
        response.say("I'd be happy to help you schedule an appointment. I'm texting you our booking information now.");
        const bookingLinks = [tenant?.booking?.main_url || tenant?.booking_url || tenant?.contact?.website || ""];
        if (bookingLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, bookingLinks, tenant, 'booking');
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

// Handle new/returning client responses - CONDITIONAL (SINGLE INSTANCE ONLY)
    else if (tenant?.advanced_features?.new_vs_returning_flow && !handled) {
      if (lowerSpeech.includes('new client') || lowerSpeech.includes('first time') || 
           lowerSpeech.includes('never been') || lowerSpeech.includes('new customer') ||
           (lowerSpeech.includes('new') && !lowerSpeech.includes('returning'))) {
        if (tenant?.advanced_features?.service_portal) {
          response.say("Welcome! Since you're a new client, you'll need to get a personalized quote first for your specific loc needs. I'm texting you our service portal link now where you can select your service and get pricing.");
          const servicePortalLink = tenant?.service_portal?.url || tenant?.booking?.main_url || "";
          if (servicePortalLink) {
            await sendLinksViaSMS(fromNumber, toNumber, [servicePortalLink], tenant, 'service_portal');
          }
        } else {
          response.say("Welcome! I'm texting you our booking information now.");
          const bookingLinks = [tenant?.booking?.main_url || tenant?.booking_url || ""];
          if (bookingLinks[0]) {
            await sendLinksViaSMS(fromNumber, toNumber, bookingLinks, tenant, 'booking');
          }
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
      
      else if (lowerSpeech.includes('returning client') || lowerSpeech.includes('been here before') ||
               lowerSpeech.includes('existing client') || lowerSpeech.includes('regular client') ||
               lowerSpeech.includes('come here before') || lowerSpeech.includes('returning customer') ||
               (lowerSpeech.includes('returning') && !lowerSpeech.includes('new'))) {
        if (tenant?.advanced_features?.maintenance_booking_links) {
          response.say("Great! Since you're a returning client, what service do you usually get? I can send you a direct booking link. For example, say retwist, wick maintenance, interlock, sisterlocks, crochet, or bald coverage.");
          response.gather({
            input: "speech",
            action: "/handle-speech",
            method: "POST",
            timeout: 12,
            speechTimeout: "auto"
          });
          response.say("Which service would you like to book?");
          handled = true;
        } else {
          response.say("Great! Since you're a returning client, I'm texting you our booking information now.");
          const bookingLinks = [tenant?.booking?.main_url || tenant?.booking_url || ""];
          if (bookingLinks[0]) {
            await sendLinksViaSMS(fromNumber, toNumber, bookingLinks, tenant, 'booking');
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
    }
    
    // CONDITIONAL: Handle returning client service selection responses - SINGLE INSTANCE ONLY
    else if (tenant?.advanced_features?.maintenance_booking_links && !handled) {
      if (lowerSpeech.includes('retwist') || lowerSpeech.includes('palm roll')) {
        response.say("Perfect! I'm texting you the direct booking link for your retwist maintenance appointment now.");
        const bookingLink = getMaintenanceBookingLink('retwist', tenant);
        if (bookingLink && bookingLink !== '#') {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'retwist_booking');
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
      
      else if (lowerSpeech.includes('wick') && tenant?.advanced_features?.wick_locs) {
        response.say("Perfect! I'm texting you the direct booking link for your wick loc maintenance appointment now.");
        const bookingLink = getMaintenanceBookingLink('wick', tenant);
        if (bookingLink && bookingLink !== '#') {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'wick_booking');
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
      
      else if (lowerSpeech.includes('interlock')) {
        response.say("Perfect! I'm texting you the direct booking link for your interlock maintenance appointment now.");
        const bookingLink = getMaintenanceBookingLink('interlock', tenant);
        if (bookingLink && bookingLink !== '#') {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'interlock_booking');
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
      
      else if (lowerSpeech.includes('sisterlock') || lowerSpeech.includes('sister lock') || 
               lowerSpeech.includes('microlock') || lowerSpeech.includes('micro lock')) {
        response.say("Perfect! I'm texting you the direct booking link for your sisterlock maintenance appointment now.");
        const bookingLink = getMaintenanceBookingLink('sisterlock', tenant);
        if (bookingLink && bookingLink !== '#') {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'sisterlock_booking');
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
      
      else if (lowerSpeech.includes('crochet')) {
        response.say("Perfect! I'm texting you the direct booking link for your crochet roots maintenance appointment now.");
        const bookingLink = getMaintenanceBookingLink('crochet', tenant);
        if (bookingLink && bookingLink !== '#') {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'crochet_booking');
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
      
      else if (lowerSpeech.includes('bald coverage') || lowerSpeech.includes('bald spot') || 
               (lowerSpeech.includes('bald') && tenant?.advanced_features?.bald_coverage)) {
        response.say("Perfect! I'm texting you the direct booking link for your bald coverage maintenance appointment now.");
        const bookingLink = getMaintenanceBookingLink('bald_coverage', tenant);
        if (bookingLink && bookingLink !== '#') {
          await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, 'bald_coverage_booking');
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

    // Running late notification - CONDITIONAL
    else if (lowerSpeech.includes('running late') || 
        lowerSpeech.includes('running behind') ||
        lowerSpeech.includes('late for') ||
        (lowerSpeech.includes('late') && lowerSpeech.includes('appointment'))) {
      const lateResponse = tenant?.custom_responses?.running_late || 
        `Thanks for the update! ${tenant?.loctician_name || 'We have'} been informed you're running behind.`;
      response.say(lateResponse);
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
    
    // CONDITIONAL: Service-specific quote requests
    else if (tenant?.advanced_features?.quote_system) {
      if (lowerSpeech.includes('wick') && (lowerSpeech.includes('loc') || lowerSpeech.includes('quote')) && tenant?.advanced_features?.wick_locs) {
        response.say("Yes we do wick locs. Start your quote at our service portal for pricing and booking instructions. I'm texting you the wick maintenance quote link now.");
        const wickLinks = [tenant?.quote_system?.urls?.wick_maintenance || tenant?.booking?.main_url || ""];
        if (wickLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, wickLinks, tenant, 'wick_maintenance');
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
      
      else if (lowerSpeech.includes('bald coverage') || lowerSpeech.includes('bald spot')) {
        if (tenant?.advanced_features?.bald_coverage) {
          response.say("Yes, bald coverage is one of our specialties. This is a quote-based service. I'm texting you the bald coverage quote link now.");
          const baldLinks = [tenant?.quote_system?.urls?.bald_coverage || tenant?.booking?.main_url || ""];
          if (baldLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, baldLinks, tenant, 'bald_coverage');
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
      
      else if (lowerSpeech.includes('repair') && lowerSpeech.includes('loc')) {
        if (tenant?.advanced_features?.loc_repair) {
          response.say(`Yes, loc repair is our specialty. ${tenant?.loctician_name || 'Our stylist'} is an expert in repair techniques. I'm texting you the repair quote link now.`);
          const repairLinks = [tenant?.quote_system?.urls?.repair || tenant?.booking?.main_url || ""];
          if (repairLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, repairLinks, tenant, 'repair');
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
      
      else if (lowerSpeech.includes('start') && lowerSpeech.includes('loc')) {
        response.say("Yes, we start locs using comb coil, braid locs, and 2 strand twist methods. I'm texting you our starter loc information now.");
        const starterLinks = [tenant?.quote_system?.urls?.starter_locs || tenant?.booking?.main_url || ""];
        if (starterLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, starterLinks, tenant, 'starter_locs');
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
    
    // CONDITIONAL: Training program inquiries
    else if (tenant?.advanced_features?.training_program && 
             (lowerSpeech.includes('training') || lowerSpeech.includes('course') || 
              lowerSpeech.includes('teach') || lowerSpeech.includes('learn'))) {
      let trainingResponse = `Yes, we offer a comprehensive Loc Repair Training Program. It's ${tenant?.training_program?.cost || '$49 per week'}, cancel anytime, no experience required. `;
      
      if (lowerSpeech.includes('sign up') || lowerSpeech.includes('enroll') || lowerSpeech.includes('how to')) {
        trainingResponse += `You can ${tenant?.training_program?.signup_method || 'contact us'} or send a direct message to ${tenant?.training_program?.instagram_dm || 'our Instagram'} to enroll.`;
      } else if (lowerSpeech.includes('experience') || lowerSpeech.includes('beginner')) {
        trainingResponse += "No experience is required. Our program is designed for beginners and we welcome students at all skill levels.";
      } else {
        trainingResponse += `It's hands-on weekly training where you learn professional repair techniques. Students who complete earn ${tenant?.training_program?.bonus || 'special benefits'}.`;
      }
      
      response.say(trainingResponse);
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
    
    // Hours inquiry with follow-up - CONDITIONAL
    else if (lowerSpeech.includes('hour') || lowerSpeech.includes('open') || lowerSpeech.includes('close')) {
      const hoursResponse = tenant?.custom_responses?.hours_with_portal || 
        `We're ${tenant?.hours?.hours_string || 'open during business hours'} by appointment only. What service are you interested in so I can help you get started?`;
      
      response.say(hoursResponse);
      
      if (tenant?.advanced_features?.service_portal) {
        const portalLinks = [tenant?.service_portal?.url || tenant?.booking?.main_url || ""];
        if (portalLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, portalLinks, tenant, 'service_portal');
      } else {
        const bookingLinks = [tenant?.booking?.main_url || tenant?.booking_url || ""];
        if (bookingLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, bookingLinks, tenant, 'booking');
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
    
    // Pricing-only requests - CONDITIONAL
    else if ((lowerSpeech.includes('price') || lowerSpeech.includes('cost') || lowerSpeech.includes('pricing') || lowerSpeech.includes('how much')) &&
              !lowerSpeech.includes('appointment') && !lowerSpeech.includes('book') && !lowerSpeech.includes('schedule')) {
      
      if (tenant?.advanced_features?.quote_system) {
        response.say("Our pricing is quote-based since everyone's needs are different. I'm texting you our service portal where you can get personalized pricing for your specific loc needs.");
        const portalLinks = [tenant?.service_portal?.url || tenant?.booking?.main_url || ""];
        if (portalLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, portalLinks, tenant, 'service_portal');
      } else {
        response.say("I'm texting you our pricing information now.");
        const bookingLinks = [tenant?.booking?.main_url || tenant?.booking_url || ""];
        if (bookingLinks[0]) await sendLinksViaSMS(fromNumber, toNumber, bookingLinks, tenant, 'pricing');
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
          response.say(appointmentResult.speech);
          handled = true;
          
          // Send appointment lookup link for management requests
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
        }
      }
    }

    // Continue conversation with flow control
    if (handled) {
      // Only hang up for explicit goodbye phrases
      if (lowerSpeech.includes('bye') || lowerSpeech.includes('goodbye') || 
          lowerSpeech.includes('that\'s all') || lowerSpeech.includes('that is all') ||
          lowerSpeech.includes('nothing else') || lowerSpeech.includes('no more') ||
          lowerSpeech.includes('i\'m done') || lowerSpeech.includes('im done') ||
          lowerSpeech.includes('have a good day') || lowerSpeech.includes('talk to you later') ||
          (lowerSpeech.includes('no') && (lowerSpeech.includes('thank') || lowerSpeech.includes('good')))) {
        response.say("You're welcome! Have a great day!");
        response.hangup();
      } else if (lowerSpeech.includes('no') && lowerSpeech.length <= 15 && 
                 !lowerSpeech.includes('english') && !lowerSpeech.includes('problem')) {
        response.say("Looks like you're all set! Feel free to call back anytime if you need help. Have a great day!");
        response.hangup();
      }
    } else {
      // If not handled, use OpenAI
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
        response.say(`${cleanResponse} I'm texting you the link now.`);
      } else {
        response.say(aiResponse);
      }

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
    fastify.log.error({ err }, "Speech processing error");
    response.say("I'm having a technical issue. Let me try again - what did you need help with?");
    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 10,
      speechTimeout: "auto"
    });
    response.say("I'm listening.");
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
      response.message(`Thanks for texting! Call us or visit our website for assistance.`);
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
