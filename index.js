import Fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import fs from "fs";
import OpenAI from "openai";

// ----------------------------------------------------------------------------
// Fastify + plugins
// ----------------------------------------------------------------------------
const fastify = Fastify({ logger: true });
await fastify.register(formbody);

// ----------------------------------------------------------------------------
/** ENV */
// ----------------------------------------------------------------------------
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  OPENAI_API_KEY,
  AIRTABLE_PAT,
  INSTAGRAM_VERIFY_TOKEN,
  PAGE_ACCESS_TOKEN,        // <-- ensure this is set in your env
  PORT = 10000,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !OPENAI_API_KEY || !AIRTABLE_PAT) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

const twiml = twilio.twiml.VoiceResponse;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---- IG DEBUG BUFFER (stores the latest IG webhook so you can grab PSID) ----
let LAST_IG_WEBHOOK = null;

// ----------------------------------------------------------------------------
// ElevenLabs (unchanged except for logging)
// ----------------------------------------------------------------------------
async function generateElevenLabsAudio(text, tenant) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) return null;

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
          text,
          model_id: "eleven_flash_v2_5",
          voice_settings: { stability: 0.75, similarity_boost: 0.8, speed: 1.0 }
        }),
      }
    );
    if (!response.ok) throw new Error(`ElevenLabs API error: ${response.status}`);
    return await response.arrayBuffer();
  } catch (error) {
    fastify.log.error({ err: error }, "ElevenLabs TTS error");
    return null;
  }
}

async function respondWithNaturalVoice(response, text, tenant) {
  try {
    if (process.env.ELEVENLABS_API_KEY) {
      const audioBuffer = await generateElevenLabsAudio(text, tenant);
      if (audioBuffer) {
        const audioFilename = `audio_${Date.now()}.mp3`;
        const audioPath = `/tmp/${audioFilename}`;
        fs.writeFileSync(audioPath, Buffer.from(audioBuffer));
        // NOTE: ensure you serve /audio/* elsewhere if you rely on this URL
        response.play(`https://locsync-q7z9.onrender.com/audio/${audioFilename}`);
        fastify.log.info("Using ElevenLabs voice for response");
        return true;
      }
    }
  } catch (error) {
    fastify.log.error({ err: error }, "Voice generation failed, using fallback");
  }
  response.say(text);
  fastify.log.info("Using Twilio TTS fallback");
  return false;
}

// ----------------------------------------------------------------------------
// Tenants loading (unchanged)
// ----------------------------------------------------------------------------
let TENANTS = {};
let TENANT_DETAILS = new Map();

try {
  TENANTS = JSON.parse(fs.readFileSync("./tenants.json", "utf8"));
  fastify.log.info("✅ Loaded tenants registry");
} catch (e) {
  fastify.log.warn("⚠️ No tenants.json found. Using defaults.");
}

function extractUrls(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

async function sendLinksViaSMS(fromNumber, toNumber, links, tenant, serviceType = null) {
  if (!links.length || !tenant?.voice_config?.send_links_via_sms) return;
  try {
    let message = "";

    if (links.length === 1) {
      const link = links[0];
      if (tenant?.advanced_features?.service_portal) {
        if (serviceType === 'wick_maintenance') message = `Wick Locs Maintenance Quote: ${link}`;
        else if (serviceType === 'bald_coverage') message = `Bald Coverage Quote: ${link}`;
        else if (serviceType === 'repair') message = `Loc Repair Quote: ${link}`;
        else if (serviceType === 'starter_locs') message = `Starter Locs Quote: ${link}`;
        else if (serviceType === 'sisterlocks') message = `Sisterlocks Maintenance Quote: ${link}`;
        else if (serviceType === 'service_portal') message = `Service Portal - Get personalized quotes: ${link}`;
      }
      if (serviceType === 'retwist_booking') message = `Book your Retwist/Palm Roll appointment: ${link}`;
      else if (serviceType === 'wick_booking') message = `Book your Wick Loc maintenance appointment: ${link}`;
      else if (serviceType === 'interlock_booking') message = `Book your Interlock maintenance appointment: ${link}`;
      else if (serviceType === 'sisterlock_booking') message = `Book your Sisterlock/Microlock maintenance appointment: ${link}`;
      else if (serviceType === 'crochet_booking') message = `Book your Crochet Roots maintenance appointment: ${link}`;
      else if (serviceType === 'bald_coverage_booking') message = `Book your Bald Coverage maintenance appointment: ${link}`;
      else if (serviceType === 'consultation_booking') message = `Book your consultation appointment: ${link}`;
      if (serviceType === 'website') message = `Visit our website for language support chatbot: ${link}`;
      else if (serviceType === 'instagram') message = `Follow us on Instagram: ${link}`;
      else if (serviceType === 'appointment_lookup') message = `Appointment Lookup - Find and manage your appointments: ${link}`;
      else if (link.includes('directions')) message = `Here are the detailed directions to our door: ${link}`;
      else if (!message) message = `Here's the link we mentioned: ${link}`;
    } else {
      message = `Here are the links we mentioned:\n${links.map((link, i) => {
        if (link.includes('service_portal')) return `${i + 1}. Service Portal: ${link}`;
        if (link.includes('directions')) return `${i + 1}. Directions: ${link}`;
        if (link.includes('instagram')) return `${i + 1}. Instagram: ${link}`;
        if (link.includes('appointment-lookup')) return `${i + 1}. Appointment Lookup: ${link}`;
        return `${i + 1}. ${link}`;
      }).join('\n')}`;
    }

    await twilioClient.messages.create({ body: message, from: toNumber, to: fromNumber });
    fastify.log.info({ fromNumber, linkCount: links.length, serviceType, messageType: 'service_link' }, "SMS sent successfully");
  } catch (err) {
    fastify.log.error({ err, fromNumber, serviceType }, "Failed to send SMS");
  }
}

function getServiceBookingLink(serviceType, tenant, isReturningClient = false) {
  if (isReturningClient && tenant?.advanced_features?.new_vs_returning_flow) {
    if (tenant?.maintenance_booking_links?.links) {
      const link = tenant.maintenance_booking_links.links[serviceType];
      if (link) return { url: link, type: 'booking' };
    }
    if (tenant?.booking?.maintenance_links) {
      const link = tenant.booking.maintenance_links[serviceType];
      if (link) return { url: link, type: 'booking' };
    }
  }
  if (tenant?.advanced_features?.quote_system && tenant?.quote_system?.urls) {
    const link = tenant.quote_system.urls[serviceType];
    if (link) return { url: link, type: 'quote' };
  }
  if (tenant?.maintenance_booking_links?.links) {
    const link = tenant.maintenance_booking_links.links[serviceType];
    if (link) return { url: link, type: 'booking' };
  }
  if (tenant?.booking?.maintenance_links) {
    const link = tenant.booking.maintenance_links[serviceType];
    if (link) return { url: link, type: 'booking' };
  }
  if (tenant?.booking?.consultation_url) return { url: tenant.booking.consultation_url, type: 'consultation' };
  return { url: tenant?.booking?.main_url || null, type: 'general' };
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-10);
}

function loadTenantDetails(tenantId) {
  if (TENANT_DETAILS.has(tenantId)) return TENANT_DETAILS.get(tenantId);
  try {
    const detailsPath = `./tenants/${tenantId}/config.json`;
    if (fs.existsSync(detailsPath)) {
      const details = JSON.parse(fs.readFileSync(detailsPath, "utf8"));
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
        if (tenantNormalized === normalized) { baseTenant = tenant; break; }
      }
    }
  }
  if (!baseTenant) baseTenant = Object.values(TENANTS)[0] || null;
  if (baseTenant?.tenant_id) {
    const details = loadTenantDetails(baseTenant.tenant_id);
    return { ...baseTenant, ...details };
  }
  return baseTenant;
}

// Map IG business account id to a tenant
async function getTenantByInstagramId(instagramId) {
  for (const [phoneNumber, tenant] of Object.entries(TENANTS)) {
    const fullTenant = getTenantByToNumber(phoneNumber);
    if (fullTenant?.instagram?.business_account_id === instagramId) return fullTenant;
  }
  return null;
}

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
    if (fs.existsSync("./knowledge.md")) return fs.readFileSync("./knowledge.md", "utf8");
  } catch (err) {
    fastify.log.warn({ err }, "Error loading knowledge");
  }
  return "";
}

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
  const customGreeting = t.voice_config?.greeting_tts ||
    `Thank you for calling ${t.studio_name || 'our salon'}. How can I help you?`;

  let appointmentFlow = "";
  if (t.advanced_features?.service_portal && t.advanced_features?.new_vs_returning_flow) {
    appointmentFlow = `
APPOINTMENT BOOKING FLOW:
1) Ask: "Are you a new client or a returning client?"
2) NEW: Send service portal (quote) link
3) RETURNING: Ask service, send DIRECT BOOKING link`;
  } else {
    appointmentFlow = `
APPOINTMENT BOOKING FLOW:
1) Ask what service they need
2) Send appropriate booking or consultation link`;
  }

  let serviceResponses = "";
  if (t.services?.quote_urls || t.quote_system?.urls) serviceResponses += "Use quote URLs for NEW clients.\n";
  if (t.maintenance_booking_links?.links || t.booking?.maintenance_links) serviceResponses += "Use direct booking links for RETURNING clients.\n";
  if (t.booking?.consultation_url) serviceResponses += "Use consultation URL when unsure.\n";

  let trainingInfo = "";
  if (t.training_program?.enabled || t.advanced_features?.training_program) {
    trainingInfo = `\nTraining Program: ${t.training_program?.cost || "Available"} - ${t.training_program?.signup_method || "Contact for details"}`;
  }

  const canonicalQA = (t.canonical_answers || [])
    .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`)
    .join("\n") || "(Use general responses)";

  let prompt = `You are the virtual receptionist for "${t.studio_name || 'our salon'}" with ${loctician}${experience ? ` (${experience})` : ""}.
CRITICAL:
- Keep responses under 15 seconds
- Never spell out URLs
- Answer directly without repeating questions
- Offer to text useful links
- NEW clients → quotes; RETURNING → direct booking

${appointmentFlow}

Salon:
- Name: ${t.studio_name || 'The Salon'}
- Loctician: ${loctician}${experience ? ` - ${experience}` : ""}
- Hours: ${hours}
- Services: ${services || "Hair care"}
${specialties ? `- Specialties: ${specialties}` : ""}
${address}

${serviceResponses}
${trainingInfo}

${website ? `Website: ${website}` : ""}
${instagram ? `Instagram: ${instagram}` : ""}

Canonical Q&A:
${canonicalQA}

Knowledge:
${(knowledgeText || "").slice(0, 8000)}
`;
  return prompt.slice(0, 15000);
}

// --- Airtable helpers (unchanged) ---
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
      headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' }
    });
    if (!response.ok) throw new Error(`Airtable API error: ${response.status}`);
    const data = await response.json();
    fastify.log.info({ recordCount: data.records?.length }, "Airtable response");
    if (action === 'lookup_appointments') {
      return processAppointmentLookup(data.records || [], params.phone, tenant, requestType);
    }
    return { handled: true, speech: "Request processed", data };
  } catch (err) {
    fastify.log.error({ err, action }, "Airtable API error");
    return { handled: false, speech: "I'm having trouble accessing appointments. Please try again in a moment." };
  }
}

function processAppointmentLookup(records, searchPhone, tenant, requestType = 'lookup') {
  if (records.length === 0) {
    return { handled: true, speech: `I don't see any appointments under your number. Would you like to book a new appointment?`, data: { appointments: [], needsBooking: true } };
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
    try { return new Date(apt.date) >= now; } catch { return true; }
  });

  if (upcoming.length === 0) {
    return { handled: true, speech: `I don't see any upcoming appointments under your number. Would you like to schedule a new appointment?`, data: { appointments: [], needsBooking: true } };
  }

  if (requestType === 'time' || requestType === 'when') {
    if (upcoming.length === 1) {
      const next = upcoming[0];
      const timeInfo = next.time ? ` at ${next.time}` : '';
      const dateInfo = next.date ? formatAppointmentDate(next.date) : '';
      return { handled: true, speech: `Your ${next.service} appointment is scheduled for ${dateInfo}${timeInfo}.`, data: { appointments: upcoming } };
    } else {
      const allAppts = upcoming.map((apt, i) => {
        const aptTime = apt.time ? ` at ${apt.time}` : '';
        const aptDate = apt.date ? formatAppointmentDate(apt.date) : '';
        return `${apt.service} on ${aptDate}${aptTime}`;
      });
      return { handled: true, speech: `You have ${upcoming.length} upcoming appointments: ${allAppts.join(', and ')}. Which appointment did you want to know about?`, data: { appointments: upcoming } };
    }
  }

  if (requestType === 'manage' || requestType === 'cancel' || requestType === 'reschedule') {
    if (upcoming.length === 1) {
      const next = upcoming[0];
      const timeInfo = next.time ? ` at ${next.time}` : '';
      const dateInfo = next.date ? formatAppointmentDate(next.date) : '';
      return { handled: true, speech: `You have an appointment for ${next.service} on ${dateInfo}${timeInfo}. I'm texting you the confirmation link to manage it.`, data: { appointments: upcoming, sendConfirmation: true } };
    } else {
      const allAppts = upcoming.map((apt, i) => {
        const aptTime = apt.time ? ` at ${apt.time}` : '';
        const aptDate = apt.date ? formatAppointmentDate(apt.date) : '';
        return `${i + 1}. ${apt.service} on ${aptDate}${aptTime}`;
      });
      return { handled: true, speech: `You have ${upcoming.length} appointments: ${allAppts.join(', ')}. Which appointment would you like to manage? I'm texting you the confirmation link to help you manage any of them.`, data: { appointments: upcoming, sendConfirmation: true, needsSelection: true } };
    }
  }

  if (upcoming.length === 1) {
    const next = upcoming[0];
    const timeInfo = next.time ? ` at ${next.time}` : '';
    const dateInfo = next.date ? formatAppointmentDate(next.date) : '';
    return { handled: true, speech: `You have an appointment for ${next.service} scheduled for ${dateInfo}${timeInfo}. How can I help you with it?`, data: { appointments: upcoming } };
  } else {
    const allAppts = upcoming.map((apt, i) => {
      const aptTime = apt.time ? ` at ${apt.time}` : '';
      const aptDate = apt.date ? formatAppointmentDate(apt.date) : '';
      return `${i + 1}. ${apt.service} on ${aptDate}${aptTime}`;
    });
    return { handled: true, speech: `You have ${upcoming.length} upcoming appointments: ${allAppts.join(', and ')}. Which appointment would you like help with, or would you like to manage all of them?`, data: { appointments: upcoming } };
  }
}

function extractTimeFromDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch { return ''; }
}

function formatAppointmentDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  } catch { return dateStr; }
}

// ----------------------------------------------------------------------------
// INSTAGRAM WEBHOOKS + SENDER (patched)
// ----------------------------------------------------------------------------

// Verification (GET): echoes hub.challenge
fastify.get("/instagram-webhook", async (req, reply) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === INSTAGRAM_VERIFY_TOKEN) {
    fastify.log.info("Instagram webhook verified");
    reply.code(200).send(challenge);
  } else {
    fastify.log.warn("Instagram webhook verification failed");
    reply.code(403).send("Forbidden");
  }
});

// Incoming events (POST)
fastify.post("/instagram-webhook", async (req, reply) => {
  try {
    const body = req.body;

    // Save & log for easy PSID extraction (/debug/last-ig)
    LAST_IG_WEBHOOK = body;
    fastify.log.info({ rawPayload: body }, "📩 IG webhook payload received");

    if (body.object !== "instagram") {
      reply.code(400).send("Not an Instagram object");
      return;
    }

    // Events: entry[].changes[].value.messaging[]
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const msgs = change?.value?.messaging || [];
        for (const messagingEvent of msgs) {
          await handleInstagramDMEvent(messagingEvent);
        }
      }
    }

    // Always acknowledge
    reply.code(200).send("EVENT_RECEIVED");
  } catch (error) {
    fastify.log.error({ err: error }, "Instagram webhook error");
    reply.code(200).send("ERROR");
  }
});

async function handleInstagramDMEvent(messagingEvent) {
  try {
    fastify.log.info({ fullPayload: messagingEvent }, "Instagram messaging event received");

    // Ignore non-message updates
    if (messagingEvent?.message_edit || messagingEvent?.read || messagingEvent?.delivery || messagingEvent?.reaction) {
      fastify.log.info("Skipping non-message event");
      return;
    }

    const text = messagingEvent?.message?.text || "";
    const senderId = messagingEvent?.sender?.id;      // IG user PSID
    const recipientId = messagingEvent?.recipient?.id; // IG business acct id

    if (!senderId || !recipientId) {
      fastify.log.warn({ messagingEvent }, "Missing sender/recipient");
      return;
    }
    if (!text) {
      fastify.log.info("No text message");
      return;
    }

    fastify.log.info({ senderId, text }, "ACTUAL MESSAGE RECEIVED");

    const tenant = await getTenantByInstagramId(recipientId);
    if (!tenant) {
      fastify.log.error("No tenant found for this Instagram account");
      return;
    }

    const replyText = tenant?.instagram?.greeting_message || "Hi! Thanks for your message. How can we help?";
    await sendInstagramMessage(senderId, replyText, tenant);
  } catch (error) {
    fastify.log.error({ err: error, stack: error.stack }, "handleInstagramDMEvent error");
  }
}

// Sending message (uses PAGE access token)
async function sendInstagramMessage(recipientId, messageText, tenant) {
  try {
    const pageAccessToken = tenant?.instagram?.page_access_token || PAGE_ACCESS_TOKEN;
    if (!pageAccessToken) throw new Error("Missing PAGE access token");

    const url = "https://graph.facebook.com/v23.0/me/messages";
    const payload = {
      messaging_product: "instagram",
      recipient: { id: recipientId },
      message: { text: messageText },
    };

    const res = await fetch(`${url}?access_token=${encodeURIComponent(pageAccessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Graph API error ${res.status}: ${errText}`);
    }
    fastify.log.info({ recipientId }, "✅ Instagram message sent successfully");
  } catch (error) {
    fastify.log.error({ err: error.message, recipientId }, "❌ Failed to send Instagram message");
  }
}

// ----------------------------------------------------------------------------
// DEBUG endpoint to view last IG webhook (grab PSID in browser)
// ----------------------------------------------------------------------------
fastify.get("/debug/last-ig", async (req, reply) => {
  try {
    reply.type("application/json").send(LAST_IG_WEBHOOK || { note: "No IG payload received yet" });
  } catch (err) {
    fastify.log.error({ err }, "Failed to render /debug/last-ig");
    reply.code(500).send({ error: "Failed to load debug payload" });
  }
});

// ----------------------------------------------------------------------------
// START SERVER (single listen with clean port handling)
// ----------------------------------------------------------------------------
const port = Number(PORT) || 10000;
fastify
  .listen({ port, host: "0.0.0.0" })
  .then(() => fastify.log.info(`🚀 Server listening on ${port}`))
  .catch((err) => {
    fastify.log.error({ err }, "Failed to start server");
    process.exit(1);
  });
