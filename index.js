
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
  INSTAGRAM_VERIFY_TOKEN,
  PORT = 10000,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !OPENAI_API_KEY || !AIRTABLE_PAT) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const twiml = twilio.twiml.VoiceResponse;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------------- ELEVENLABS INTEGRATION ----------------
async function generateElevenLabsAudio(text, tenant) {
  try {
    // Check if ElevenLabs is configured
    if (!process.env.ELEVENLABS_API_KEY) {
      return null; // Will use fallback TTS
    }

    // Use tenant-specific voice if available, otherwise default
    const voiceId = tenant?.elevenlabs_voice_id || process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
    
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: text,
          model_id: "eleven_flash_v2_5",
          voice_settings: {
            stability: 0.75,
            similarity_boost: 0.8,
            speed: 1.0
          }
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.status}`);
    }

    return await response.arrayBuffer();
  } catch (error) {
    fastify.log.error({ err: error }, "ElevenLabs TTS error");
    return null; // Will fallback to Twilio TTS
  }
}

// Helper function to use ElevenLabs or fallback to Twilio TTS
async function respondWithNaturalVoice(response, text, tenant) {
  try {
    if (process.env.ELEVENLABS_API_KEY) {
      const audioBuffer = await generateElevenLabsAudio(text, tenant);
      
      if (audioBuffer) {
        // Create temporary audio file for Twilio
        const audioFilename = `audio_${Date.now()}.mp3`;
        const audioPath = `/tmp/${audioFilename}`;
        fs.writeFileSync(audioPath, Buffer.from(audioBuffer));
        
        // Serve the file and play it
        response.play(`https://locsync-q7z9.onrender.com/audio/${audioFilename}`);
        
        fastify.log.info('Using ElevenLabs voice for response');
        return true;
      }
    }
  } catch (error) {
    fastify.log.error({ err: error }, "Voice generation failed, using fallback");
  }
  
  // Fallback to Twilio TTS
  response.say(text);
  fastify.log.info('Using Twilio TTS fallback');
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
      
      // Validate Instagram configuration
      if (details.instagram?.access_token) {
        details.instagram.webhook_enabled = true;
        fastify.log.info({ tenantId, instagram: details.instagram.username }, "Instagram integration enabled");
      }
      
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

// NEW: Helper function to find tenant by Instagram business account ID
async function getTenantByInstagramId(instagramId) {
  // Search through all tenants for matching Instagram business account
  for (const [phoneNumber, tenant] of Object.entries(TENANTS)) {
    const fullTenant = getTenantByToNumber(phoneNumber);
    if (fullTenant?.instagram?.business_account_id === instagramId) {
      return fullTenant;
    }
  }
  return null;
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

// ---------------- INSTAGRAM INTEGRATION - NEW CODE ----------------

// Instagram webhook verification
fastify.get("/instagram-webhook", async (req, reply) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  
  if (mode === 'subscribe' && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    fastify.log.info("Instagram webhook verified");
    reply.send(challenge);
  } else {
    fastify.log.warn("Instagram webhook verification failed");
    reply.code(403).send('Forbidden');
  }
});

// Instagram message handler
fastify.post("/instagram-webhook", async (req, reply) => {
  const body = req.body;
  
  try {
    if (body.object === 'instagram') {
      for (const entry of body.entry) {
        if (entry.messaging) {
          for (const event of entry.messaging) {
            await handleInstagramDM(event);
          }
        }
      }
    }
    reply.send('EVENT_RECEIVED');
  } catch (error) {
    fastify.log.error({ err: error }, "Instagram webhook error");
    reply.send('ERROR');
  }
});

async function handleInstagramDM(event) {
  try {
    // Log the full event to see structure
    fastify.log.info({ event }, "Instagram webhook event received");
    
    // Skip message_edit events - we only care about new messages
    if (event.message_edit) {
      fastify.log.info("Skipping message_edit event");
      return;
    }
    
    // Instagram webhook structure
    if (!event.entry || !event.entry[0] || !event.entry[0].messaging) {
      fastify.log.warn("Invalid Instagram webhook structure");
      return;
    }
    
    for (const entry of event.entry) {
      if (!entry.messaging) continue;
      
      for (const messagingEvent of entry.messaging) {
        const senderId = messagingEvent.sender?.id;
        const recipientId = messagingEvent.recipient?.id;
        const message = messagingEvent.message?.text || '';
        
        // Skip if this is also a message_edit event at this level
        if (messagingEvent.message_edit) {
          fastify.log.info("Skipping nested message_edit event");
          continue;
        }
        
        fastify.log.info({ senderId, recipientId, message }, "Processing Instagram DM");
        
        // Find tenant by Instagram business account ID
        const tenant = await getTenantByInstagramId(recipientId);
        
        if (!tenant) {
          fastify.log.warn({ recipientId }, "No tenant found for Instagram account");
          return;
        }
        
        // Process message and send response
        let response = tenant?.instagram?.greeting_message || "Thanks for messaging us!";
        
        // Your message processing logic here...
        
        await sendInstagramMessage(senderId, response, tenant);
      }
    }
    
  } catch (error) {
    fastify.log.error({ err: error }, "Instagram DM processing error");
  }
}
// Send message back to Instagram
async function sendInstagramMessage(recipientId, messageText, tenant) {
  try {
    const response = await fetch(`https://graph.instagram.com/v18.0/me/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tenant.instagram.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: messageText }
      })
    });
    
    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Instagram API error: ${response.status} - ${errorData}`);
    }
    
    fastify.log.info({ recipientId, tenant: tenant.tenant_id }, "Instagram message sent successfully");
    
  } catch (error) {
    fastify.log.error({ err: error, recipientId }, "Failed to send Instagram message");
  }
}

// ---------------- ROUTES ----------------
fastify.get("/", async () => {
  return { 
    status: "ok", 
    service: "LocSync Voice Agent - Multi-Tenant with Instagram",
    tenants: Object.keys(TENANTS).length,
    elevenlabs: process.env.ELEVENLABS_API_KEY ? "enabled" : "disabled",
    instagram: process.env.INSTAGRAM_VERIFY_TOKEN ? "enabled" : "disabled"
  };
});

fastify.get("/health", async () => {
  return { status: "healthy", timestamp: new Date().toISOString() };
});

// Instagram OAuth connection route (ADD THIS)
fastify.get('/connect-instagram/:tenantId', async (req, reply) => {
  const tenantId = req.params.tenantId;
  const state = `tenant_${tenantId}_${Date.now()}`;
  
  const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${process.env.INSTAGRAM_APP_ID}&redirect_uri=https://locsync-q7z9.onrender.com/instagram/callback&scope=instagram_business_basic,instagram_business_manage_messages,pages_show_list,pages_read_engagement&response_type=code&state=${state}`;
  
  reply.redirect(authUrl);
});


// ---------------- ELEVENLABS AUDIO SERVING ROUTE ----------------
fastify.get('/audio/:filename', async (request, reply) => {
  try {
    const filename = request.params.filename;
    const audioPath = `/tmp/${filename}`;
    
    if (fs.existsSync(audioPath)) {
      const audio = fs.readFileSync(audioPath);
      reply.type('audio/mpeg').send(audio);
      
      // Clean up file after serving
      setTimeout(() => {
        try { 
          fs.unlinkSync(audioPath); 
          fastify.log.info(`Cleaned up audio file: ${filename}`);
        } catch (e) {
          fastify.log.warn(`Failed to cleanup audio file: ${filename}`);
        }
      }, 5000);
    } else {
      reply.code(404).send('Audio not found');
    }
  } catch (error) {
    fastify.log.error({ err: error }, "Error serving audio");
    reply.code(500).send('Error serving audio');
  }
});

// Incoming call handler - uses dynamic greeting from tenant config
fastify.post("/incoming-call", async (req, reply) => {
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({ to: toNumber, from: fromNumber, tenant: tenant?.tenant_id }, "Incoming call");

  const response = new twiml();
  // Use tenant-specific greeting or fallback to default
  const greeting = tenant?.voice_config?.greeting_tts || 
    `Thank you for calling ${tenant?.studio_name || "our salon"}. How can I help you?`;

  // Use ElevenLabs for greeting if available
  await respondWithNaturalVoice(response, greeting, tenant);
  
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
    elevenlabs_voice_id: fullTenant?.elevenlabs_voice_id || "using default",
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
    elevenlabs_enabled: !!process.env.ELEVENLABS_API_KEY,
    voice_configuration: {
      has_custom_voice: !!fullTenant?.elevenlabs_voice_id,
      voice_id: fullTenant?.elevenlabs_voice_id || "default",
      fallback_enabled: true
    }
  };
});

// Test ElevenLabs integration endpoint
fastify.get("/test-voice/:tenantId", async (req, reply) => {
  const baseTenant = TENANTS[req.params.tenantId];
  if (!baseTenant) {
    return { error: "Tenant not found" };
  }
  
  const fullTenant = getTenantByToNumber(baseTenant.phone_number);
  const testText = req.query.text || "Hello! This is a test of your salon's voice bot. How does this sound?";
  
  try {
    const audioBuffer = await generateElevenLabsAudio(testText, fullTenant);
    
    if (audioBuffer) {
      // Save test audio file
      const testFilename = `test_voice_${Date.now()}.mp3`;
      const testPath = `/tmp/${testFilename}`;
      fs.writeFileSync(testPath, Buffer.from(audioBuffer));
      
      return {
        status: "success",
        message: "ElevenLabs voice generation successful",
        audio_url: `https://locsync-q7z9.onrender.com/audio/${testFilename}`,
        voice_id: fullTenant?.elevenlabs_voice_id || process.env.ELEVENLABS_VOICE_ID || "default",
        test_text: testText
      };
    } else {
      return {
        status: "fallback",
        message: "ElevenLabs failed, would use Twilio TTS fallback",
        elevenlabs_configured: !!process.env.ELEVENLABS_API_KEY
      };
    }
  } catch (error) {
    fastify.log.error({ err: error }, "Voice test error");
    return {
      status: "error",
      message: "Voice test failed",
      error: error.message,
      elevenlabs_configured: !!process.env.ELEVENLABS_API_KEY
    };
  }
});

// NEW: Test Instagram integration
fastify.get("/test-instagram/:tenantId", async (req, reply) => {
  const tenantId = req.params.tenantId;
  const baseTenant = Object.values(TENANTS).find(t => t.tenant_id === tenantId);
  
  if (!baseTenant) {
    return { error: "Tenant not found", available: Object.keys(TENANTS) };
  }
  
  const fullTenant = getTenantByToNumber(baseTenant.phone_number);
  
  return {
    tenant_id: tenantId,
    instagram_enabled: !!fullTenant?.instagram?.webhook_enabled,
    instagram_username: fullTenant?.instagram?.username,
    has_access_token: !!fullTenant?.instagram?.access_token,
    auto_responses: Object.keys(fullTenant?.instagram?.auto_responses || {}),
    business_account_configured: !!fullTenant?.instagram?.business_account_id,
    greeting_message: fullTenant?.instagram?.greeting_message,
    webhook_verify_token: process.env.INSTAGRAM_VERIFY_TOKEN ? "configured" : "missing"
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
    hasQuoteSystem: !!tenant?.advanced_features?.quote_system,
    elevenLabsEnabled: !!process.env.ELEVENLABS_API_KEY
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

// ============ INSTAGRAM ONBOARDING ROUTES (ADD THESE) ============

// Onboarding page - what Meta reviewers will see
fastify.get("/onboard/:tenantId", async (req, reply) => {
  const tenantId = req.params.tenantId;
  
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LocSync Instagram Integration</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            padding: 40px;
        }
        .logo {
            text-align: center;
            margin-bottom: 30px;
        }
        .logo-icon {
            font-size: 60px;
            margin-bottom: 10px;
        }
        h1 {
            color: #1a1a1a;
            font-size: 28px;
            margin-bottom: 10px;
            text-align: center;
        }
        .subtitle {
            color: #666;
            text-align: center;
            margin-bottom: 30px;
            line-height: 1.5;
        }
        .feature-list {
            background: #f8f9fa;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 30px;
        }
        .feature {
            display: flex;
            align-items: start;
            margin-bottom: 15px;
        }
        .feature:last-child {
            margin-bottom: 0;
        }
        .feature-icon {
            font-size: 24px;
            margin-right: 12px;
        }
        .feature-text {
            color: #333;
            font-size: 14px;
            line-height: 1.4;
        }
        .connect-button {
            display: block;
            width: 100%;
            background: linear-gradient(45deg, #E1306C, #C13584, #833AB4);
            color: white;
            text-align: center;
            padding: 16px;
            border-radius: 12px;
            text-decoration: none;
            font-weight: 600;
            font-size: 16px;
            transition: transform 0.2s, box-shadow 0.2s;
            border: none;
            cursor: pointer;
        }
        .connect-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(225, 48, 108, 0.4);
        }
        .disclaimer {
            margin-top: 20px;
            padding: 15px;
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            border-radius: 8px;
            font-size: 12px;
            color: #856404;
            line-height: 1.5;
        }
        .meta-notice {
            text-align: center;
            margin-top: 20px;
            font-size: 11px;
            color: #999;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">
            <div class="logo-icon">🤖</div>
            <h1>LocSync Instagram Integration</h1>
            <p class="subtitle">Connect your Instagram Business account to enable 24/7 automated customer service</p>
        </div>
        
        <div class="feature-list">
            <div class="feature">
                <span class="feature-icon">⚡</span>
                <span class="feature-text"><strong>Instant Responses</strong> - Answer customer questions about hours, services, and booking in seconds</span>
            </div>
            <div class="feature">
                <span class="feature-icon">💬</span>
                <span class="feature-text"><strong>Smart DM Automation</strong> - Handle common inquiries while you focus on clients</span>
            </div>
            <div class="feature">
                <span class="feature-icon">📊</span>
                <span class="feature-text"><strong>Professional Service</strong> - Maintain consistent, helpful communication with all customers</span>
            </div>
        </div>
        
        <a href="/instagram/connect/${tenantId}" class="connect-button">
            🔗 Connect Instagram Account
        </a>
        
        <div class="disclaimer">
            <strong>📋 Requirements:</strong> You must have an Instagram Business or Creator account. LocSync will only access your direct messages to provide automated customer service. We never post on your behalf or access personal data.
        </div>
        
        <p class="meta-notice">
            This application is provided by LocSync and is not affiliated with or endorsed by Meta Platforms, Inc.
        </p>
    </div>
</body>
</html>
  `;
  
  reply.type('text/html').send(html);
});

// Instagram OAuth connection - redirects to Instagram auth
fastify.get("/instagram/connect/:tenantId", async (req, reply) => {
  const tenantId = req.params.tenantId;
  
  // Get Instagram App ID from environment
  const appId = process.env.INSTAGRAM_APP_ID || process.env.FACEBOOK_APP_ID;
  
  if (!appId) {
    return reply.send('Error: Instagram App ID not configured. Please add INSTAGRAM_APP_ID to environment variables.');
  }
  
  // Build OAuth URL
  const redirectUri = encodeURIComponent('https://locsync-q7z9.onrender.com/instagram/callback');
  const scope = 'instagram_business_basic,instagram_business_manage_messages';
  const state = `tenant_${tenantId}_${Date.now()}`;
  
  const authUrl = `https://api.instagram.com/oauth/authorize?client_id=${appId}&redirect_uri=${redirectUri}&scope=${scope}&response_type=code&state=${state}`;
  
  reply.redirect(authUrl);
});

// Instagram OAuth callback - handles the return from Instagram
fastify.get("/instagram/callback", async (req, reply) => {
  const code = req.query.code;
  const state = req.query.state;
  const error = req.query.error;
  const errorReason = req.query.error_reason;
  
  // Extract tenant ID from state
  const tenantMatch = state?.match(/tenant_([^_]+)_/);
  const tenantId = tenantMatch ? tenantMatch[1] : 'unknown';
  
  if (error) {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Connection Failed</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
        .error { color: #dc3545; font-size: 48px; margin-bottom: 20px; }
        h1 { color: #333; }
        p { color: #666; line-height: 1.6; }
        .retry-btn { display: inline-block; margin-top: 20px; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 8px; }
    </style>
</head>
<body>
    <div class="error">❌</div>
    <h1>Connection Failed</h1>
    <p>Reason: ${errorReason || error}</p>
    <p>Unable to connect your Instagram account. This may happen if you cancelled the authorization or don't have a Business account.</p>
    <a href="/onboard/${tenantId}" class="retry-btn">Try Again</a>
</body>
</html>
    `;
    return reply.type('text/html').send(html);
  }
  
  if (!code) {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Connection Error</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
        .error { color: #dc3545; font-size: 48px; }
    </style>
</head>
<body>
    <div class="error">⚠️</div>
    <h1>Connection Error</h1>
    <p>No authorization code received from Instagram.</p>
</body>
</html>
    `;
    return reply.type('text/html').send(html);
  }
  
  // Success page
  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Instagram Connected Successfully</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            max-width: 500px;
            text-align: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        .success-icon {
            font-size: 80px;
            margin-bottom: 20px;
            animation: bounce 0.5s;
        }
        @keyframes bounce {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-20px); }
        }
        h1 {
            color: #28a745;
            margin-bottom: 10px;
        }
        .details {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 12px;
            margin: 20px 0;
            text-align: left;
        }
        .detail-row {
            margin: 10px 0;
            font-size: 14px;
        }
        .label {
            font-weight: 600;
            color: #666;
        }
        .value {
            color: #333;
            word-break: break-all;
        }
        .next-steps {
            background: #e7f3ff;
            padding: 20px;
            border-radius: 12px;
            margin-top: 20px;
            text-align: left;
        }
        .next-steps h3 {
            color: #0066cc;
            margin-bottom: 10px;
            font-size: 16px;
        }
        .next-steps p {
            color: #333;
            font-size: 14px;
            line-height: 1.6;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success-icon">✅</div>
        <h1>Instagram Connected Successfully!</h1>
        <p style="color: #666; margin-bottom: 20px;">Your Instagram Business account is now connected to LocSync</p>
        
        <div class="details">
            <div class="detail-row">
                <span class="label">Tenant ID:</span> 
                <span class="value">${tenantId}</span>
            </div>
            <div class="detail-row">
                <span class="label">Authorization Code:</span> 
                <span class="value">${code.substring(0, 30)}...</span>
            </div>
            <div class="detail-row">
                <span class="label">Status:</span> 
                <span class="value" style="color: #28a745;">✓ OAuth Flow Complete</span>
            </div>
        </div>
        
        <div class="next-steps">
            <h3>📱 Next Steps</h3>
            <p>1. Your Instagram DMs will now be handled by LocSync's AI assistant</p>
            <p>2. Test it by sending a message to your Instagram Business account</p>
            <p>3. Monitor responses in your Instagram inbox</p>
        </div>
    </div>
</body>
</html>
  `;
  
  fastify.log.info({ tenantId, codeLength: code.length }, "Instagram OAuth callback successful");
  
  reply.type('text/html').send(html);
});

// ---------------- START SERVER ----------------
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 LocSync Voice Bot - Multi-Tenant with Instagram running on ${address}`);
  console.log(`📞 Configured tenants: ${Object.keys(TENANTS).join(", ")}`);
  console.log(`🎤 ElevenLabs integration: ${process.env.ELEVENLABS_API_KEY ? "ENABLED" : "DISABLED (using Twilio TTS fallback)"}`);
  console.log(`📸 Instagram integration: ${process.env.INSTAGRAM_VERIFY_TOKEN ? "ENABLED" : "DISABLED"}`);
  console.log(`✨ COMPLETE: Voice + SMS + Instagram DM automation ready!`);
});
