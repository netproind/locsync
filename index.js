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
let TENANT_DETAILS = new Map(); // Cache for detailed tenant info

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

// Function to send SMS with links
async function sendLinksViaSMS(fromNumber, toNumber, links, tenant) {
  if (!links.length || !tenant?.voice_config?.send_links_via_sms) return;
  
  try {
    let message = "";
    
    if (links.length === 1) {
      // Single link - determine what type it is
      const link = links[0];
      if (link.includes('directions')) {
        message = `Here are the detailed directions to our door: ${link}`;
      } else if (link.includes('instagram')) {
        message = `Follow us on Instagram: ${link}`;
      } else if (link.includes('wick-maintenance')) {
        message = `Wick Locs Maintenance Quote: ${link}`;
      } else if (link.includes('bald-quote')) {
        message = `Bald Coverage Quote: ${link}`;
      } else if (link.includes('repair-quote')) {
        message = `Loc Repair Quote: ${link}`;
      } else if (link.includes('retwist-quote')) {
        message = `Starter Locs Quote: ${link}`;
      } else if (link.includes('micro-sister')) {
        message = `Sisterlocks Maintenance Quote: ${link}`;
      } else if (link.includes('appointment-lookup')) {
        message = `Appointment Lookup - Find and manage your appointments: ${link}`;
      } else if (link.includes('appointment-confirmation')) {
        message = `Manage your appointment here: ${link}`;
      } else if (link.includes('locrepair.com') && !link.includes('service_portal')) {
        message = `Visit our website for language support chatbot: ${link}`;
      } else {
        message = `Here's the link we mentioned: ${link}`;
      }
    } else {
      // Multiple links
      message = `Here are the links we mentioned:\n${links.map((link, i) => {
        if (link.includes('service_portal')) return `${i + 1}. Service Portal: ${link}`;
        if (link.includes('directions')) return `${i + 1}. Directions: ${link}`;
        if (link.includes('instagram')) return `${i + 1}. Instagram: ${link}`;
        if (link.includes('appointment-lookup')) return `${i + 1}. Appointment Lookup: ${link}`;
        if (link.includes('appointment-confirmation')) return `${i + 1}. Appointment Management: ${link}`;
        if (link.includes('locrepair.com')) return `${i + 1}. Website (Language Support): ${link}`;
        return `${i + 1}. ${link}`;
      }).join('\n')}`;
    }
    
    await twilioClient.messages.create({
      body: message,
      from: toNumber,
      to: fromNumber
    });
    
    fastify.log.info({ fromNumber, linkCount: links.length, messageType: 'links' }, "SMS with links sent successfully");
  } catch (err) {
    fastify.log.error({ err, fromNumber }, "Failed to send SMS with links");
  }
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
  const bookingSite = t.booking?.booking_site || t.booking?.square_site || t.square_site || "";
  const depositInfo = t.policies?.deposits ? "Deposits required for appointments" : "Deposits may be required";
  const cancellationPolicy = t.policies?.cancellation ? "Please check our cancellation policy" : "Please call to cancel";
  
  // Canonical answers
  const canonicalQA = (t.canonical_answers || [])
    .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`)
    .join("\n") || "(none)";
  
  // Build comprehensive but concise prompt
  let prompt = `You are the virtual receptionist for "${t.studio_name || 'our salon'}" with ${loctician}${experience ? ` (${experience})` : ""}.

CRITICAL INSTRUCTIONS:
- Keep responses under 15 seconds
- Never spell out URLs - just say "visit our website" or "check our portal"
- DO NOT repeat or rephrase the customer's question back to them
- Answer directly and naturally
- Be conversational and helpful
- For appointment requests, guide them to the service portal and offer to text links
- Never tell someone to just "visit our online system" and hang up
- Address payment security concerns by mentioning in-person deposit options
- Always offer to text helpful links and directions
- Acknowledge when clients are running late and inform them Yesha is notified
- When providing address, always say the full street address clearly
- For non-English speakers, offer callback options or texting for translation help
- When texting links, always mention what type of link you're sending

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

  return prompt.slice(0, 15000);
}
// Airtable API integration
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

// Process appointment lookup results - TENANT-AWARE
function processAppointmentLookup(records, searchPhone, tenant, requestType = 'lookup') {
  const bookingUrl = tenant?.booking?.main_url || tenant?.booking_url || "our online booking system";
  const bookingSite = tenant?.booking?.booking_site || tenant?.booking?.square_site || tenant?.square_site || "";
  
  if (records.length === 0) {
    if (requestType === 'booking') {
      return {
        handled: true,
        speech: `I don't see any existing appointments. What type of service are you looking for today?`,
        data: { appointments: [], needsBooking: true }
      };
    }
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

  // Filter for upcoming appointments only
  const now = new Date();
  const upcoming = appointments.filter(apt => {
    if (!apt.date) return true;
    try {
      return new Date(apt.date) >= now;
    } catch {
      return true;
    }
  });

  // If requesting to book and they have upcoming appointments
  if (requestType === 'booking' && upcoming.length > 0) {
    const next = upcoming[0];
    const timeInfo = next.time ? ` at ${next.time}` : '';
    return {
      handled: true,
      speech: `I see you already have an upcoming appointment for ${next.service}${timeInfo}. Would you like to schedule an additional appointment or manage your existing one?`,
      data: { appointments: upcoming, hasExisting: true }
    };
  }

  // If no upcoming appointments (only past ones)
  if (upcoming.length === 0) {
    if (requestType === 'booking') {
      return {
        handled: true,
        speech: `I don't see any upcoming appointments. Are you a returning client looking to book another appointment, or do you need a new service quote?`,
        data: { appointments: [], needsBooking: true, isReturning: true }
      };
    } else {
      return {
        handled: true,
        speech: `I don't see any upcoming appointments under your number. Would you like to schedule a new appointment?`,
        data: { appointments: [], needsBooking: true, isReturning: true }
      };
    }
  }

  // For time requests - handle multiple appointments
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
      // Multiple appointments - list all with times
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

  // For management requests
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
      // Multiple appointments - ask which one
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

  // Default lookup - handle multiple appointments properly
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
    // Multiple appointments - list all appointments with full details
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

    // Handle specific scenarios first
    
    // Multiple language support with better continuation
    if (lowerSpeech.includes('español') || lowerSpeech.includes('spanish') || 
        lowerSpeech.includes('habla español') || lowerSpeech.includes('hablas español') ||
        lowerSpeech.includes('en español')) {
      response.say("Para soporte en español, puede usar nuestro chat bot en nuestro sitio web. Le envío el enlace por mensaje de texto ahora.");
      const websiteLinks = [tenant?.contact?.website || "https://www.locrepair.com"];
      await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant);
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 8,
        speechTimeout: "auto"
      });
      response.say("¿Hay algo más en que pueda ayudarle?");
      handled = true;
    }
    else if (lowerSpeech.includes('french') || lowerSpeech.includes('français') ||
             lowerSpeech.includes('parlez français') || lowerSpeech.includes('en français')) {
      response.say("Pour le support en français, vous pouvez utiliser notre chat bot sur notre site web. Je vous envoie le lien par SMS maintenant.");
      const websiteLinks = [tenant?.contact?.website || "https://www.locrepair.com"];
      await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant);
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 8,
        speechTimeout: "auto"
      });
      response.say("Y a-t-il autre chose que je puisse faire pour vous?");
      handled = true;
    }
    else if (lowerSpeech.includes('arabic') || lowerSpeech.includes('عربي') ||
             lowerSpeech.includes('تتكلم عربي')) {
      response.say("للدعم باللغة العربية، يمكنك استخدام روبوت الدردشة على موقعنا الإلكتروني. سأرسل لك الرابط عبر رسالة نصية الآن.");
      const websiteLinks = [tenant?.contact?.website || "https://www.locrepair.com"];
      await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant);
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 8,
        speechTimeout: "auto"
      });
      response.say("هل هناك شيء آخر يمكنني مساعدتك فيه؟");
      handled = true;
    }
    else if (lowerSpeech.includes('no english') || lowerSpeech.includes("don't speak english") ||
             lowerSpeech.includes('other language') || lowerSpeech.includes('translate')) {
      response.say("For language support, please use our chat bot on our website. I'm texting you the link now where you can get help in your language.");
      const websiteLinks = [tenant?.contact?.website || "https://www.locrepair.com"];
      await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant);
      handled = true;
    }
    
    // Running late notification
    else if (lowerSpeech.includes('running late') || 
        lowerSpeech.includes('running behind') ||
        lowerSpeech.includes('late for') ||
        (lowerSpeech.includes('late') && lowerSpeech.includes('appointment'))) {
      response.say(tenant?.quick_responses?.running_late || "Thanks for the update! Yesha has been informed you're running behind.");
      handled = true;
    }
    
    // Same day cancellation concerns
    else if (lowerSpeech.includes('may need to cancel') ||
             lowerSpeech.includes('might cancel') ||
             lowerSpeech.includes('same day cancel')) {
      response.say("Please note that same day cancellations forfeit the deposit. If you still need to proceed, text CANCEL to 313-455-LOCS. Do you want to continue?");
      handled = true;
    }
    
    // In-person deposit payment requests
    else if (lowerSpeech.includes('pay in person') ||
             lowerSpeech.includes('deposit in person') ||
             lowerSpeech.includes('come in to pay') ||
             lowerSpeech.includes('scam') ||
             lowerSpeech.includes('legitimate') ||
             lowerSpeech.includes('trust')) {
      response.say("I completely understand your concerns about online payments. We are a legitimate business and you can absolutely pay your deposit in person. Text DEPOSIT to 313-455-5627 to schedule a time to come in and pay.");
      handled = true;
    }
    
    // Directions and getting lost
    else if (lowerSpeech.includes('lost') ||
             lowerSpeech.includes('find you') ||
             lowerSpeech.includes('directions') ||
             lowerSpeech.includes('where are you') ||
             lowerSpeech.includes("can't find")) {
      response.say("I can help you find us! Text DIRECTIONS to 313-455-5627 and I'll send you detailed directions right to our door.");
      const directionsUrl = tenant?.contact?.directions_url;
      if (directionsUrl) {
        await sendLinksViaSMS(fromNumber, toNumber, [directionsUrl], tenant);
      }
      handled = true;
    }
    
    // Review requests
    else if (lowerSpeech.includes('review') ||
             lowerSpeech.includes('google review') ||
             lowerSpeech.includes('leave review')) {
      response.say("I'd love for you to leave a review! Text REVIEW to 313-455-5627 and I'll send you the link to our Google reviews.");
      handled = true;
    }
    
    // Service identification help
    else if (lowerSpeech.includes("don't know what service") ||
             lowerSpeech.includes("not sure what") ||
             lowerSpeech.includes("don't know what it's called") ||
             lowerSpeech.includes("help me find service")) {
      response.say("No problem! If you know you need loc service but aren't sure what it's called, text PORTAL to 313-455-5627 and we'll help you find the right service for your needs.");
      handled = true;
    }
    
    // Booking timeframe questions
    else if (lowerSpeech.includes('by when') ||
             lowerSpeech.includes('how soon') ||
             lowerSpeech.includes('book by') ||
             lowerSpeech.includes('appointment by')) {
      response.say("We book within 30 days from today. With your quote you should receive a booking link - be sure to check your spam folder. If you need the portal again, text PORTAL to 313-455-5627.");
      handled = true;
    }

    // Service-specific requests with SMS links
    else if (lowerSpeech.includes('wick') && (lowerSpeech.includes('loc') || lowerSpeech.includes('maintenance'))) {
      response.say("Yes we do wick locs. Start your quote at our service portal for pricing and booking instructions. I'm texting you the wick maintenance quote link now.");
      const wickLinks = [tenant?.services?.quote_urls?.wick_maintenance || "https://www.locrepair.com/wick-maintenance-quote/"];
      await sendLinksViaSMS(fromNumber, toNumber, wickLinks, tenant);
      handled = true;
    }
    
    else if (lowerSpeech.includes('bald coverage') || lowerSpeech.includes('bald spot')) {
      response.say("Yes, bald coverage is one of our specialties. This is a quote-based service. I'm texting you the bald coverage quote link now.");
      const baldLinks = [tenant?.services?.quote_urls?.bald_coverage || "https://www.locrepair.com/bald-quote-for-existing-locs/"];
      await sendLinksViaSMS(fromNumber, toNumber, baldLinks, tenant);
      handled = true;
    }
    
    else if (lowerSpeech.includes('repair') && lowerSpeech.includes('loc')) {
      response.say("Yes, loc repair is our specialty. Yesha is an expert in repair techniques. I'm texting you the repair quote link now.");
      const repairLinks = [tenant?.services?.quote_urls?.repair || "https://www.locrepair.com/repair-quote/"];
      await sendLinksViaSMS(fromNumber, toNumber, repairLinks, tenant);
      handled = true;
    }
    
    else if (lowerSpeech.includes('start') && lowerSpeech.includes('loc')) {
      response.say("Yes, we start locs using comb coil, braid locs, and 2 strand twist methods. I'm texting you our starter loc information now.");
      const starterLinks = [tenant?.services?.quote_urls?.retwist || "https://www.locrepair.com/retwist-quote/"];
      await sendLinksViaSMS(fromNumber, toNumber, starterLinks, tenant);
      handled = true;
    }
    
    else if (lowerSpeech.includes('sisterlock') || lowerSpeech.includes('sister lock')) {
      response.say("Yes we do sisterlocks and sisterlock maintenance. I'm texting you the maintenance quote link to help determine your specific needs.");
      const sisterlockLinks = [tenant?.services?.quote_urls?.microlocs || "https://www.locrepair.com/micro-sister-brother-locs-maintenance-quote/"];
      await sendLinksViaSMS(fromNumber, toNumber, sisterlockLinks, tenant);
      handled = true;
    }
    
    // Training program inquiries
    else if (lowerSpeech.includes('training') || lowerSpeech.includes('course') || 
             lowerSpeech.includes('teach') || lowerSpeech.includes('learn')) {
      let trainingResponse = "Yes, we offer a comprehensive Loc Repair Training Program. It's $49 per week, cancel anytime, no experience required. ";
      
      if (lowerSpeech.includes('sign up') || lowerSpeech.includes('enroll') || lowerSpeech.includes('how to')) {
        trainingResponse += "You can text START to 313-455-5627 or send a direct message to @locrepairexpert on Instagram to enroll.";
      } else if (lowerSpeech.includes('experience') || lowerSpeech.includes('beginner')) {
        trainingResponse += "No experience is required. Our program is designed for beginners and we welcome students at all skill levels.";
      } else {
        trainingResponse += "It's hands-on weekly training where you learn professional repair techniques. Students who complete earn one free month booth rental worth over $750.";
      }
      
      response.say(trainingResponse);
      handled = true;
    }
    
    // Hours inquiry with follow-up
    else if (lowerSpeech.includes('hour') || lowerSpeech.includes('open') || lowerSpeech.includes('close')) {
      response.say("We're open Sunday through Friday, 11 AM to 7 PM by appointment only. We're closed Saturdays. What service are you interested in so I can help you get started with a quote?");
      const portalLinks = [tenant?.booking?.main_url || "https://www.locrepair.com/service_portal"];
      await sendLinksViaSMS(fromNumber, toNumber, portalLinks, tenant);
      handled = true;
    }
    
    // Same day availability with proper phone pronunciation
    else if (lowerSpeech.includes('same day') || lowerSpeech.includes('today') || lowerSpeech.includes('urgent')) {
      response.say("For same day availability, text us at three one three, four five five, five six two seven.");
      handled = true;
    }
    
    // Consultation fee inquiry
    else if (lowerSpeech.includes('consultation') && (lowerSpeech.includes('fee') || lowerSpeech.includes('charge') || lowerSpeech.includes('cost'))) {
      response.say("Yes, we charge a $25 consultation fee that goes toward any appointment made. The fee may be higher for high-end services.");
      handled = true;
    }
    
    // Deposit policy
    else if (lowerSpeech.includes('deposit') && !lowerSpeech.includes('person')) {
      response.say("Yes, we require deposits. $25 for standard services and higher for specialty services like bald coverage. The deposit goes toward your appointment. I'm texting you deposit information now.");
      const depositLinks = [tenant?.booking?.main_url || "https://www.locrepair.com/service_portal"];
      await sendLinksViaSMS(fromNumber, toNumber, depositLinks, tenant);
      handled = true;
    }
    
    // Children policy
    else if (lowerSpeech.includes('kid') || lowerSpeech.includes('child') || lowerSpeech.includes('bring my')) {
      response.say("Children are only allowed if they have their own appointment scheduled.");
      handled = true;
    }
    
    // Pet policy
    else if (lowerSpeech.includes('dog') || lowerSpeech.includes('pet') || lowerSpeech.includes('animal')) {
      response.say("Only service animals are allowed for health and safety reasons.");
      handled = true;
    }
    
    // Address/location requests
    else if (lowerSpeech.includes('address') || lowerSpeech.includes('location') ||
             lowerSpeech.includes('where are you') || lowerSpeech.includes('where located') ||
             lowerSpeech.includes('how to get there') || lowerSpeech.includes('where is')) {
      const address = tenant?.address || "25240 Lahser Road, Suite 9, Southfield, Michigan 48033";
      response.say(`We're located at ${address}. I'm texting you the address and detailed directions now.`);
      
      const addressLinks = [tenant?.contact?.directions_url || "https://www.locrepair.com/directions-and-appointment-info"];
      await sendLinksViaSMS(fromNumber, toNumber, addressLinks, tenant);
      handled = true;
    }
    
    // Website/Instagram requests
    else if (lowerSpeech.includes('website') || lowerSpeech.includes('web site') ||
             lowerSpeech.includes('online') || lowerSpeech.includes('url')) {
      response.say("I'm texting you our website link now so you can easily access it.");
      const websiteLinks = [tenant?.contact?.website || "https://www.locrepair.com"];
      await sendLinksViaSMS(fromNumber, toNumber, websiteLinks, tenant);
      handled = true;
    }
    
    else if (lowerSpeech.includes('instagram') || lowerSpeech.includes('insta') ||
             lowerSpeech.includes('social media')) {
      response.say("I'm texting you our Instagram link now.");
      const instaLinks = [tenant?.contact?.instagram_url || "https://www.instagram.com/locrepairexpert"];
      await sendLinksViaSMS(fromNumber, toNumber, instaLinks, tenant);
      handled = true;
    }
    
    // Combination requests (appointment + pricing)
    else if ((lowerSpeech.includes('appointment') || lowerSpeech.includes('book') || lowerSpeech.includes('schedule')) &&
        (lowerSpeech.includes('price') || lowerSpeech.includes('cost') || lowerSpeech.includes('pricing') || lowerSpeech.includes('how much'))) {
      
      // First handle appointment lookup
      const appointmentResult = await callAirtableAPI(tenant, 'lookup_appointments', {
        phone: fromNumber
      }, 'booking');
      
      let combinedResponse = "";
      if (appointmentResult.handled) {
        combinedResponse = appointmentResult.speech + " ";
      }
      
      // Add pricing information
      combinedResponse += "Our pricing is quote-based since everyone's needs are different. I'm texting you our service portal where you can get personalized pricing.";
      
      response.say(combinedResponse);
      
      // Send booking links
      const bookingUrl = tenant?.booking?.main_url || tenant?.booking_url;
      const bookingSite = tenant?.booking?.booking_site || tenant?.booking?.square_site || tenant?.square_site;
      
      if (bookingUrl) {
        const links = [bookingUrl];
        if (bookingSite && bookingSite !== bookingUrl) {
          links.push(bookingSite);
        }
        await sendLinksViaSMS(fromNumber, toNumber, links, tenant);
      }
      
      handled = true;
    }

      // Determine the type of request for existing appointment logic
      let requestType = 'lookup'; // default
      
      if (!handled) {
        // Check for date-specific appointment management FIRST
        if ((lowerSpeech.includes('manage') || lowerSpeech.includes('cancel') || lowerSpeech.includes('reschedule')) &&
            (lowerSpeech.includes('monday') || lowerSpeech.includes('tuesday') || lowerSpeech.includes('wednesday') || 
             lowerSpeech.includes('thursday') || lowerSpeech.includes('friday') || lowerSpeech.includes('saturday') || 
             lowerSpeech.includes('sunday') || lowerSpeech.includes('december') || lowerSpeech.includes('january') ||
             lowerSpeech.includes('february') || lowerSpeech.includes('march') || lowerSpeech.includes('april') ||
             lowerSpeech.includes('may') || lowerSpeech.includes('june') || lowerSpeech.includes('july') ||
             lowerSpeech.includes('august') || lowerSpeech.includes('september') || lowerSpeech.includes('october') ||
             lowerSpeech.includes('november') || /\b\d{1,2}(st|nd|rd|th)?\b/.test(lowerSpeech))) {
          
          let actionWord = "manage";
          if (lowerSpeech.includes('cancel')) actionWord = "cancel";
          else if (lowerSpeech.includes('reschedule')) actionWord = "reschedule";
          
          response.say(`I understand you want to ${actionWord} your specific appointment. I'm texting you the appointment lookup page where you can find and ${actionWord} your appointment using your confirmation details.`);
          
          const appointmentLookupUrl = tenant?.contact?.appointment_lookup || "https://www.locrepair.com/appointment-lookup.html";
          await sendLinksViaSMS(fromNumber, toNumber, [appointmentLookupUrl], tenant);
          handled = true;
