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

// ---- IG DEBUG BUFFER ----
let LAST_IG_WEBHOOK = null;

// ---------------- ELEVENLABS INTEGRATION ----------------
async function generateElevenLabsAudio(text, tenant) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      return null; // Will use fallback TTS
    }

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
        const audioFilename = `audio_${Date.now()}.mp3`;
        const audioPath = `/tmp/${audioFilename}`;
        fs.writeFileSync(audioPath, Buffer.from(audioBuffer));
        response.play(`https://locsync-q7z9.onrender.com/audio/${audioFilename}`);
        fastify.log.info('Using ElevenLabs voice for response');
        return true;
      }
    }
  } catch (error) {
    fastify.log.error({ err: error }, "Voice generation failed, using fallback");
  }
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
  if (tenant?.booking?.consultation_url) {
    return { url: tenant.booking.consultation_url, type: 'consultation' };
  }
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

// NEW: Helper function to find tenant by Instagram business account ID
async function getTenantByInstagramId(instagramId) {
  for (const [phoneNumber, tenant] of Object.entries(TENANTS)) {
    const fullTenant = getTenantByToNumber(phoneNumber);
    if (fullTenant?.instagram?.business_account_id === instagramId) {
      return fullTenant;
    }
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
  const customGreeting = t.voice_config?.greeting_tts || `Thank you for calling ${t.studio_name || 'our salon'}. How can I help you?`;

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

  let trainingInfo = "";
  if (t.training_program?.enabled || t.advanced_features?.training_program) {
    trainingInfo = `
Training Program: ${t.training_program?.cost || "Available"} - ${t.training_program?.signup_method || "Contact for details"}`;
  }

  const canonicalQA = (t.canonical_answers || [])
    .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`)
    .join("\n") || "(Use general responses)";

  let prompt = `You are the virtual receptionist for "${t.studio_name || 'our salon'}" with ${loctician}${experience ? ` (${experience})` : ""}.
...
${(knowledgeText || "").slice(0, 8000)}
...`;

  return prompt.slice(0, 15000);
}

// ---------------- INSTAGRAM INTEGRATION - VERIFIED WEBHOOK + SENDER ----------------

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


// Instagram message handler (correct Instagram payload shape)
fastify.post("/instagram-webhook", async (req, reply) => {
  try {
    const body = req.body;
fastify.log.info({ rawPayload: JSON.stringify(messagingEvent) }, "Webhook message event");
    if (body.object !== "instagram") {
      reply.code(400).send("Not an Instagram object");
      return;
    }

    // Instagram DM events: entry[].changes[].value.messaging[]
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const msgs = change?.value?.messaging || [];
        for (const messagingEvent of msgs) {
          await handleInstagramDMEvent(messagingEvent);
        }
      }
    }

    reply.send("EVENT_RECEIVED");
  } catch (error) {
    fastify.log.error({ err: error }, "Instagram webhook error");
    reply.code(200).send("ERROR");
  }
});

// Unified handler for a single Instagram messaging event
async function handleInstagramDMEvent(messagingEvent) {
  try {
    fastify.log.info({ fullPayload: messagingEvent }, "Instagram messaging event received");

    if (
      messagingEvent?.message_edit ||
      messagingEvent?.read ||
      messagingEvent?.delivery ||
      messagingEvent?.reaction
    ) {
      fastify.log.info("Skipping non-message event");
      return;
    }

    const text = messagingEvent?.message?.text || "";
    const senderId = messagingEvent?.sender?.id;       // IG user PSID
    const recipientId = messagingEvent?.recipient?.id; // Your IG business account id

    if (!senderId || !recipientId) {
      fastify.log.warn({ messagingEvent }, "Missing sender/recipient in event");
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

    const replyText =
      tenant?.instagram?.greeting_message ||
      "Hi! Thanks for your message. How can we help?";

    await sendInstagramMessage(senderId, replyText, tenant);
  } catch (error) {
    fastify.log.error({ err: error, stack: error.stack }, "handleInstagramDMEvent error");
  }
}

// Send Instagram Message — correct Graph endpoint + Page Access Token
async function sendInstagramMessage(recipientId, messageText, tenant) {
  try {
    const pageAccessToken =
      tenant?.instagram?.page_access_token || process.env.PAGE_ACCESS_TOKEN;

    if (!pageAccessToken) {
      throw new Error("Missing PAGE access token");
    }

    const url = "https://graph.facebook.com/v21.0/me/messages";
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

// ---------------- OPTIONAL: SUBSCRIBE PAGE TO APP ----------------
// One-time helper endpoint: call once per Page to allow message webhooks in production.
fastify.post("/subscribe-page", async (req, reply) => {
  try {
    const { page_id, access_token } = req.body;
    if (!page_id || !access_token) {
      return reply.code(400).send({
        error: "Missing page_id or access_token in request body",
        example: { page_id: "123456789012345", access_token: "EAA..." }
      });
    }

    const res = await fetch(
      `https://graph.facebook.com/v21.0/${page_id}/subscribed_apps?subscribed_fields=messages&access_token=${encodeURIComponent(access_token)}`,
      { method: "POST" }
    );

    const data = await res.json();
    if (!res.ok) {
      fastify.log.error({ status: res.status, data }, "Page subscription failed");
      return reply.code(res.status).send({ success: false, error: data });
    }

    fastify.log.info({ page_id }, "✅ Page subscribed to app messages successfully");
    return reply.send({ success: true, data });
  } catch (err) {
    fastify.log.error({ err }, "subscribe-page error");
    reply.code(500).send({ success: false, error: err.message });
  }
});
// === PATCH END ===
// ---------------- ROUTES ----------------
fastify.get("/", async () => {
  return { 
    status: "ok", 
    service: "LocSync Voice Agent - Multi-Tenant with Instagram",
    tenantsLoaded: Object.keys(TENANTS).length 
  };
});

fastify.get("/audio/:filename", async (req, reply) => {
  const { filename } = req.params;
  const filePath = `/tmp/${filename}`;
  if (!fs.existsSync(filePath)) {
    reply.code(404).send("Audio file not found");
    return;
  }
  reply.header("Content-Type", "audio/mpeg");
  const stream = fs.createReadStream(filePath);
  return reply.send(stream);
});

// ---------------- VOICE INCOMING ----------------
fastify.post("/voice", async (req, reply) => {
  const response = new twiml.VoiceResponse();
  try {
    const toNumber = req.body.To || TWILIO_PHONE_NUMBER;
    const fromNumber = req.body.From;

    const tenant = getTenantByToNumber(toNumber);
    const tenantName = tenant?.studio_name || "our salon";
    const greeting = tenant?.voice_config?.greeting_tts || `Thank you for calling ${tenantName}. How can I help you today?`;

    const knowledgeText = loadKnowledgeFor(tenant);
    const prompt = buildVoicePrompt(tenant, knowledgeText);

    // IVR greeting via ElevenLabs (if configured) else Twilio TTS
    await respondWithNaturalVoice(response, greeting, tenant);

    // Gather speech input
    const gather = response.gather({
      input: "speech",
      hints: "appointments, pricing, quotes, directions, hours, training, website, Instagram",
      language: "en-US",
      action: "/voice/handle-speech",
      method: "POST",
      speechTimeout: "auto"
    });

    gather.say("Please tell me what you need. For example, you can say, book an appointment, request a quote, or get directions.");

    reply.header("Content-Type", "text/xml").send(response.toString());
  } catch (err) {
    fastify.log.error({ err }, "Voice route error");
    response.say("Sorry, there was an error. Please try again later.");
    reply.header("Content-Type", "text/xml").send(response.toString());
  }
});

// ---------------- HANDLE SPEECH ----------------
fastify.post("/voice/handle-speech", async (req, reply) => {
  const response = new twiml.VoiceResponse();
  try {
    const toNumber = req.body.To || TWILIO_PHONE_NUMBER;
    const fromNumber = req.body.From;
    const userSpeech = (req.body.SpeechResult || "").trim();
    fastify.log.info({ fromNumber, userSpeech }, "Speech captured");

    const tenant = getTenantByToNumber(toNumber);
    const knowledgeText = loadKnowledgeFor(tenant);
    const prompt = buildVoicePrompt(tenant, knowledgeText);

    // Build user instruction for LLM
    const instruction = `
User said: "${userSpeech}"
Follow the APPOINTMENT BOOKING FLOW rules and respond succinctly.
If you mention any link, put it plainly in the text.
If you ask to send a link by SMS, say "I will text you the link now."`;

    const messages = [
      { role: "system", content: prompt },
      { role: "user", content: instruction }
    ];

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2
    });

    const aiText = (completion.choices?.[0]?.message?.content || "").trim() || 
      "I can help you with appointments, quotes, or directions. What would you like to do?";

    const foundLinks = extractUrls(aiText);
    if (foundLinks.length) {
      await sendLinksViaSMS(fromNumber, toNumber, foundLinks, tenant, null);
    }

    await respondWithNaturalVoice(response, aiText, tenant);

    // Optionally loop or end
    response.pause({ length: 1 });
    response.say("If you need anything else, just ask.");
    reply.header("Content-Type", "text/xml").send(response.toString());
  } catch (err) {
    fastify.log.error({ err }, "Handle speech error");
    response.say("Sorry, there was an error processing your request.");
    reply.header("Content-Type", "text/xml").send(response.toString());
  }
});

// ---------------- SMS FALLBACK / LINKS ----------------
fastify.post("/sms", async (req, reply) => {
  try {
    const body = (req.body.Body || "").trim();
    const to = req.body.To;
    const from = req.body.From;
    const tenant = getTenantByToNumber(to);

    if (/help|menu|start/i.test(body)) {
      const msg = `Hi! This is ${tenant?.studio_name || "our salon"}.\nReply with:\n- QUOTE for new client quotes\n- BOOK for returning client booking\n- HOURS for business hours\n- DIRECTIONS for directions`;
      await twilioClient.messages.create({ body: msg, from: to, to: from });
    } else if (/hours/i.test(body)) {
      const msg = tenant?.hours?.hours_string || "Please visit our site for hours.";
      await twilioClient.messages.create({ body: msg, from: to, to: from });
    } else if (/directions/i.test(body)) {
      const link = tenant?.contact?.directions_url || tenant?.contact?.maps_url || "";
      const msg = link ? `Directions: ${link}` : "Please call us for directions.";
      await twilioClient.messages.create({ body: msg, from: to, to: from });
    } else {
      const msg = `Thanks for texting ${tenant?.studio_name || "our salon"}! How can we help?`;
      await twilioClient.messages.create({ body: msg, from: to, to: from });
    }

    reply.send("OK");
  } catch (err) {
    fastify.log.error({ err }, "SMS route error");
    reply.code(500).send("Error");
  }
});

// ---------------- BOOKING SHORTCUTS ----------------
fastify.get("/links/:service", async (req, reply) => {
  try {
    const toNumber = req.query.to || TWILIO_PHONE_NUMBER;
    const serviceType = req.params.service;
    const returning = /true/i.test(req.query.returning || "false");
    const tenant = getTenantByToNumber(toNumber);

    const { url, type } = getServiceBookingLink(serviceType, tenant, returning);
    if (!url) return reply.code(404).send({ error: "No link configured" });

    return reply.send({ service: serviceType, type, url });
  } catch (err) {
    fastify.log.error({ err }, "Links route error");
    reply.code(500).send({ error: "Error" });
  }
});

// ---------------- TENANT DEBUG ----------------
fastify.get("/tenant", async (req, reply) => {
  try {
    const to = req.query.to || TWILIO_PHONE_NUMBER;
    const tenant = getTenantByToNumber(to);
    return reply.send({
      ok: true,
      to,
      tenant: {
        tenant_id: tenant?.tenant_id,
        studio_name: tenant?.studio_name,
        instagram_enabled: !!tenant?.instagram?.access_token,
        voice_features: tenant?.voice_config || {},
        booking: tenant?.booking || {}
      }
    });
  } catch (err) {
    fastify.log.error({ err }, "Tenant route error");
    reply.code(500).send({ ok: false });
  }
});

// ---------------- SERVER START ----------------
// REMOVE this line:
// const PORT = process.env.PORT || 10000;

// REPLACE your listen block with:
const port = Number(PORT) || 10000;
fastify
  .listen({ port, host: "0.0.0.0" })
  .then(() => fastify.log.info(`🚀 Server listening on ${port}`))
  .catch((err) => {
    fastify.log.error({ err }, "Failed to start server");
    process.exit(1);
  });
