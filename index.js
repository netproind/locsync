import Fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import fs from "fs";
import OpenAI from "openai";

/* -------------------------------------------------------------------------- */
/* Fastify                                                                    */
/* -------------------------------------------------------------------------- */
const fastify = Fastify({ logger: true });
await fastify.register(formbody);

/* -------------------------------------------------------------------------- */
/* ENV                                                                        */
/* -------------------------------------------------------------------------- */
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  OPENAI_API_KEY,
  AIRTABLE_PAT,
  INSTAGRAM_VERIFY_TOKEN,
  PAGE_ACCESS_TOKEN,        // <-- set this in Render env
  PORT = 10000,
  IG_REVIEW_MODE,           // "true" enables review/bypass mode
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID
} = process.env;

const REVIEW_MODE = (IG_REVIEW_MODE === "true");

// Not fatal for IG review; leave server running even if some vars are missing
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !OPENAI_API_KEY || !AIRTABLE_PAT) {
  fastify.log.warn("⚠️ Some env vars are missing (OK for IG review mode).");
}

const twiml = twilio.twiml.VoiceResponse;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* -------------------------------------------------------------------------- */
/* IG DEBUG BUFFER (store last webhook to copy PSID easily)                   */
/* -------------------------------------------------------------------------- */
let LAST_IG_WEBHOOK = null;

/* -------------------------------------------------------------------------- */
/* ElevenLabs (optional)                                                      */
/* -------------------------------------------------------------------------- */
async function generateElevenLabsAudio(text, tenant) {
  try {
    if (!ELEVENLABS_API_KEY) return null;

    const voiceId = tenant?.elevenlabs_voice_id || ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
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
    if (ELEVENLABS_API_KEY) {
      const audioBuffer = await generateElevenLabsAudio(text, tenant);
      if (audioBuffer) {
        const audioFilename = `audio_${Date.now()}.mp3`;
        const audioPath = `/tmp/${audioFilename}`;
        fs.writeFileSync(audioPath, Buffer.from(audioBuffer));
        // You would need a static route to serve /audio/* from /tmp in production if you use this.
        response.say(text); // Speak anyway; swap to .play() if you wire static serving
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

/* -------------------------------------------------------------------------- */
/* Tenants loading (safer JSON parsing)                                       */
/* -------------------------------------------------------------------------- */
let TENANTS = {};
let TENANT_DETAILS = new Map();

try {
  if (fs.existsSync("./tenants.json")) {
    TENANTS = JSON.parse(fs.readFileSync("./tenants.json", "utf8"));
    fastify.log.info("✅ Loaded tenants registry");
  } else {
    fastify.log.warn("⚠️ No tenants.json found. Using defaults.");
  }
} catch (e) {
  fastify.log.warn({ err: e }, "⚠️ Failed to parse tenants.json. Using empty tenants.");
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-10);
}

function loadTenantDetails(tenantId) {
  // Safe loader: never throw on bad JSON — just log and skip
  if (TENANT_DETAILS.has(tenantId)) return TENANT_DETAILS.get(tenantId);
  try {
    const detailsPath = `./tenants/${tenantId}/config.json`;
    if (fs.existsSync(detailsPath)) {
      const raw = fs.readFileSync(detailsPath, "utf8");
      const details = JSON.parse(raw);
      if (details.instagram?.access_token) {
        details.instagram.webhook_enabled = true;
        fastify.log.info({ tenantId, instagram: details.instagram.username }, "Instagram integration enabled");
      }
      TENANT_DETAILS.set(tenantId, details);
      return details;
    }
  } catch (err) {
    fastify.log.warn({ err, tenantId }, "Error loading tenant details (skipping)");
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

// Map IG business account id to a tenant (forgiving)
async function getTenantByInstagramId(instagramId) {
  // 1) Inline mapping on TENANTS entries
  for (const [phoneNumber, tenant] of Object.entries(TENANTS)) {
    if (tenant?.instagram?.business_account_id === instagramId) {
      const full = getTenantByToNumber(phoneNumber); // enrich if possible
      return { ...tenant, ...full };
    }
  }
  // 2) Enriched tenants (may read per-tenant config)
  for (const [phoneNumber] of Object.entries(TENANTS)) {
    const fullTenant = getTenantByToNumber(phoneNumber);
    if (fullTenant?.instagram?.business_account_id === instagramId) {
      return fullTenant;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Helpers for Airtable/text/etc. (kept from your code)                       */
/* -------------------------------------------------------------------------- */
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
function extractUrls(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

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
    return { handled: true, speech: `You have ${upcoming.length} upcoming appointments: ${allAppts.join(', and ')}. Which appointment would you like help with, or would you like to manage all of them?`, data: { appointments: upcoming } };
  }
}

/* -------------------------------------------------------------------------- */
/* INSTAGRAM: webhook + sender + debug routes                                 */
/* -------------------------------------------------------------------------- */

// Health / stop 404 noise
fastify.get("/", async (req, reply) => {
  reply.type("text/plain").send("LocSync is running");
});
fastify.head("/", async (req, reply) => {
  reply.code(200).send();
});

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

    // Collect events from BOTH possible IG payload shapes
    const collected = [];

    // Shape A: entry[].messaging[]
    for (const entry of body.entry || []) {
      if (Array.isArray(entry.messaging)) {
        collected.push(...entry.messaging);
      }
    }

    // Shape B: entry[].changes[].value.messaging[]
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const msgs = change?.value?.messaging || [];
        if (Array.isArray(msgs) && msgs.length) {
          collected.push(...msgs);
        }
      }
    }

    fastify.log.info({ count: collected.length }, "IG: collected messaging events");

    for (const evt of collected) {
      await handleInstagramDMEvent(evt);
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

    const senderId = messagingEvent?.sender?.id;       // IG user PSID
    const recipientId = messagingEvent?.recipient?.id; // IG business acct id
    const text = messagingEvent?.message?.text || "";

    // --- REVIEW MODE: always reply using PAGE token, even on edits/reads ---
    if (REVIEW_MODE) {
      if (!senderId) {
        fastify.log.warn("REVIEW_MODE: missing senderId, cannot reply");
        return;
      }
      const replyText = "Thanks for messaging Loc Repair Clinic! How can we help with your locs today? 💫";
      if (!PAGE_ACCESS_TOKEN) {
        fastify.log.error("REVIEW_MODE is ON but PAGE_ACCESS_TOKEN is missing");
        return;
      }
      await sendInstagramMessage(
        senderId,
        replyText,
        { instagram: { page_access_token: PAGE_ACCESS_TOKEN } }
      );
      fastify.log.info("REVIEW_MODE reply sent (sent regardless of event type)");
      return;
    }

    // Normal mode: ignore non-message updates
    if (messagingEvent?.message_edit || messagingEvent?.read || messagingEvent?.delivery || messagingEvent?.reaction) {
      fastify.log.info("Skipping non-message event");
      return;
    }
    if (!senderId || !recipientId) {
      fastify.log.warn({ messagingEvent }, "Missing sender/recipient");
      return;
    }
    if (!text) {
      fastify.log.info("No text message");
      return;
    }

    fastify.log.info({ senderId, text }, "ACTUAL MESSAGE RECEIVED");

    // --- NORMAL MODE: try tenant mapping; fallback to PAGE_ACCESS_TOKEN if needed ---
    let tenant = await getTenantByInstagramId(recipientId);
    const replyText =
      tenant?.instagram?.greeting_message ||
      "Hi! Thanks for your message. How can we help?";

    if (!tenant) {
      if (PAGE_ACCESS_TOKEN) {
        fastify.log.warn("Tenant lookup failed; using PAGE_ACCESS_TOKEN fallback");
        await sendInstagramMessage(senderId, replyText, { instagram: { page_access_token: PAGE_ACCESS_TOKEN } });
        return;
      } else {
        fastify.log.error("No tenant AND no PAGE_ACCESS_TOKEN; cannot send");
        return;
      }
    }

    await sendInstagramMessage(senderId, replyText, tenant);
  } catch (error) {
    fastify.log.error({ err: error, stack: error.stack }, "handleInstagramDMEvent error");
  }
}

// Sending message (uses PAGE access token) with ultra-verbose logging
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

    fastify.log.info({ url, recipientId, preview: payload }, "IG SEND: about to POST");

    const res = await fetch(`${url}?access_token=${encodeURIComponent(pageAccessToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}

    if (!res.ok) {
      fastify.log.error({
        status: res.status,
        body: text,
      }, "IG SEND ERROR");
      throw new Error(`Graph API error ${res.status}`);
    }

    fastify.log.info({ status: res.status, body: json || text }, "✅ IG SEND OK");
  } catch (error) {
    fastify.log.error({ err: error.message, recipientId }, "❌ Failed to send Instagram message");
  }
}

/* -------------------------------------------------------------------------- */
/* DEBUG endpoints                                                            */
/* -------------------------------------------------------------------------- */
fastify.get("/debug/last-ig", async (req, reply) => {
  try {
    reply.type("application/json").send(LAST_IG_WEBHOOK || { note: "No IG payload received yet" });
  } catch (err) {
    fastify.log.error({ err }, "Failed to render /debug/last-ig");
    reply.code(500).send({ error: "Failed to load debug payload" });
  }
});

// Manual debug sender: /debug/send?psid=123&text=hello
fastify.get("/debug/send", async (req, reply) => {
  try {
    const psid = req.query.psid;
    const text = req.query.text || "LocSync reply test ✅";
    if (!psid) {
      reply.code(400).send({ error: "Missing ?psid=" });
      return;
    }
    if (!PAGE_ACCESS_TOKEN) {
      reply.code(500).send({ error: "PAGE_ACCESS_TOKEN missing" });
      return;
    }
    await sendInstagramMessage(psid, text, { instagram: { page_access_token: PAGE_ACCESS_TOKEN } });
    reply.send({ ok: true, to: psid, text });
  } catch (err) {
    fastify.log.error({ err }, "/debug/send failed");
    reply.code(500).send({ error: "send failed" });
  }
});

/* -------------------------------------------------------------------------- */
/* START SERVER                                                               */
/* -------------------------------------------------------------------------- */
const port = Number(PORT) || 10000;
fastify
  .listen({ port, host: "0.0.0.0" })
  .then(() => fastify.log.info(`🚀 Server listening on ${port}`))
  .catch((err) => {
    fastify.log.error({ err }, "Failed to start server");
    process.exit(1);
  });
