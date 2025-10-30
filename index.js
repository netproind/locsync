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

// ---------------- ELEVENLABS INTEGRATION ----------------
async function generateElevenLabsAudio(text, tenant) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) {
      return null;
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

// ---------------- TENANT LOADING ----------------
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
  if (!links.length) return;
// REMOVED: !tenant?.voice_config?.send_links_via_sms check
  
  try {
    let message = "";
    
    if (links.length === 1) {
      const link = links[0];
      
      if (serviceType === 'service_portal') {
        message = `Service Portal - Get personalized quotes: ${link}`;
      } else if (serviceType === 'wick_quote') {
        message = `Wick Locs Quote: ${link}`;
      } else if (serviceType === 'bald_coverage_quote') {
        message = `Bald Coverage Quote: ${link}`;
      } else if (serviceType === 'repair_quote') {
        message = `Loc Repair Quote: ${link}`;
      } else if (serviceType === 'retwist_quote') {
        message = `Retwist Quote: ${link}`;
      } else if (serviceType === 'crochet_quote') {
        message = `Crochet Maintenance Quote: ${link}`;
      } else if (serviceType === 'interlock_quote') {
        message = `Interlock Maintenance Quote: ${link}`;
      } else if (serviceType === 'sisterlock_quote') {
        message = `Sisterlock/Microlock Maintenance Quote: ${link}`;
      } else if (serviceType === 'retwist_booking') {
        message = `Book your Retwist/Palm Roll appointment: ${link}`;
      } else if (serviceType === 'wick_booking') {
        message = `Book your Wick Loc maintenance: ${link}`;
      } else if (serviceType === 'interlock_booking') {
        message = `Book your Interlock maintenance: ${link}`;
      } else if (serviceType === 'sisterlock_booking') {
        message = `Book your Sisterlock/Microlock maintenance: ${link}`;
      } else if (serviceType === 'crochet_booking') {
        message = `Book your Crochet Roots maintenance: ${link}`;
      } else if (serviceType === 'bald_coverage_booking') {
        message = `Book your Bald Coverage maintenance: ${link}`;
      } else if (serviceType === 'consultation_booking') {
        message = `Book your consultation: ${link}`;
      } else if (serviceType === 'website') {
        message = `Visit our website: ${link}`;
      } else if (serviceType === 'instagram') {
        message = `Follow us on Instagram: ${link}`;
      } else if (serviceType === 'appointment_lookup') {
        message = `Appointment Lookup: ${link}`;
      } else if (link.includes('directions')) {
        message = `Directions to our door: ${link}`;
      } else {
        message = `Here's the link: ${link}`;
      }
    } else {
      message = `Here are the links:\n${links.map((link, i) => `${i + 1}. ${link}`).join('\n')}`;
    }
    
    await twilioClient.messages.create({
      body: message,
      from: toNumber,
      to: fromNumber
    });
    
    fastify.log.info({ fromNumber, serviceType }, "SMS sent");
    
  } catch (err) {
    fastify.log.error({ err, fromNumber, serviceType }, "Failed to send SMS");
  }
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '').slice(-10);
}

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

function buildVoicePrompt(tenant, knowledgeText) {
  const t = tenant || {};
  
  const loctician = t.loctician_name || "our stylist";
  const experience = t.experience_years ? `${t.experience_years} years experience` : "";
  
  let prompt = `You are the virtual receptionist for "${t.studio_name || 'our salon'}" with ${loctician}${experience ? ` (${experience})` : ""}.

CRITICAL INSTRUCTIONS:
- Keep responses under 15 seconds
- Answer questions about loc care, maintenance, and styling from the knowledge base
- For appointment requests, the hardcoded flow handles it (not you)
- Be conversational and helpful
- Never spell out URLs

Knowledge Base:
${(knowledgeText || "").slice(0, 10000)}

Remember: Answer loc care questions naturally using the knowledge base. For appointments, booking, or services, the system handles it automatically.`;

  return prompt.slice(0, 15000);
}

// Airtable integration (simplified)
async function callAirtableAPI(tenant, action, params = {}, requestType = 'lookup') {
  if (!tenant?.airtable_base_id || !tenant?.airtable_table_name) {
    return { handled: false, speech: "I can't access appointment information right now." };
  }

  try {
    const baseUrl = `https://api.airtable.com/v0/${tenant.airtable_base_id}/${tenant.airtable_table_name}`;
    let url = baseUrl;
    
    if (action === 'lookup_appointments' && params.phone) {
      const phoneNorm = normalizePhone(params.phone);
      url += `?filterByFormula=SEARCH("${phoneNorm}",{client_phone})`;
    }

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
    
    if (data.records && data.records.length > 0) {
      return {
        handled: true,
        speech: `I found your appointment. I'm texting you the appointment lookup link so you can manage it.`,
        data: { appointments: data.records }
      };
    } else {
      return {
        handled: true,
        speech: `I don't see any appointments under your number. Would you like to book one?`,
        data: { appointments: [] }
      };
    }

  } catch (err) {
    fastify.log.error({ err, action }, "Airtable API error");
    return { handled: false, speech: "I'm having trouble accessing appointments." };
  }
}

// ---------------- ROUTES ----------------
fastify.get("/", async () => {
  return { 
    status: "ok", 
    service: "LocSync Voice Agent - Loc Repair Clinic",
    elevenlabs: process.env.ELEVENLABS_API_KEY ? "enabled" : "disabled"
  };
});

fastify.get("/health", async () => {
  return { status: "healthy", timestamp: new Date().toISOString() };
});

fastify.get('/audio/:filename', async (request, reply) => {
  try {
    const filename = request.params.filename;
    const audioPath = `/tmp/${filename}`;
    
    if (fs.existsSync(audioPath)) {
      const audio = fs.readFileSync(audioPath);
      reply.type('audio/mpeg').send(audio);
      
      setTimeout(() => {
        try { 
          fs.unlinkSync(audioPath); 
        } catch (e) {
          fastify.log.warn(`Failed to cleanup: ${filename}`);
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

fastify.post("/incoming-call", async (req, reply) => {
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({ to: toNumber, from: fromNumber, tenant: tenant?.tenant_id }, "Incoming call");

  const response = new twiml();
  const greeting = tenant?.voice_config?.greeting_tts || 
    `Thank you for calling ${tenant?.studio_name || "our salon"}. How can I help you?`;

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

fastify.post("/incoming-sms", async (req, reply) => {
  const body = req.body?.Body?.trim() || "";
  const fromNumber = (req.body?.From || "").trim();
  const toNumber = (req.body?.To || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  const response = new twilio.twiml.MessagingResponse();

  try {
    const salonName = tenant?.studio_name || "our salon";
    response.message(`Thanks for texting ${salonName}! Call us for assistance.`);
  } catch (err) {
    fastify.log.error({ err }, "SMS error");
    response.message("Sorry, technical issues. Please call us.");
  }

  reply.type("text/xml").send(response.toString());
});

// ============================================
// MAIN SPEECH HANDLER - LOC REPAIR CLINIC
// ============================================
fastify.post("/handle-speech", async (req, reply) => {
  const speechResult = req.body?.SpeechResult?.trim() || "";
  const toNumber = (req.body?.To || "").trim();
  const fromNumber = (req.body?.From || "").trim();
  const tenant = getTenantByToNumber(toNumber);

  fastify.log.info({ speech: speechResult, tenant: tenant?.tenant_id }, "Processing speech");

  const response = new twiml();

  if (!speechResult) {
    await respondWithNaturalVoice(response, "I didn't catch that. Could you please repeat?", tenant);
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

    // ===== PRIORITY 1: APPOINTMENT REQUESTS =====
    if (!handled && (
      lowerSpeech.includes('appointment') ||
      lowerSpeech.includes('book') ||
      lowerSpeech.includes('schedule')
    )) {
      
      fastify.log.info("🎯 APPOINTMENT REQUEST - Asking new vs returning");
      
      await respondWithNaturalVoice(response, "Are you a new client or a returning client?", tenant);
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      reply.type("text/xml").send(response.toString());
      return; // EXIT - don't run anything else
    }
    
    // ===== PRIORITY 2: NEW CLIENT RESPONSE =====
    if (!handled && (
      lowerSpeech.includes('new client') ||
      lowerSpeech.includes('first time') ||
      lowerSpeech.includes('never been') ||
      lowerSpeech.includes('new customer') ||
      (lowerSpeech.includes('new') && !lowerSpeech.includes('what'))
    )) {
      
      fastify.log.info("🆕 NEW CLIENT DETECTED");
      
      await respondWithNaturalVoice(response, "Welcome! As a new client, you'll need to get a personalized quote first. Do you know which service you need, or would you like to explore our service portal?", tenant);
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 15,
        speechTimeout: "auto"
      });
      
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== PRIORITY 3: NEW CLIENT - SERVICE PORTAL (DON'T KNOW SERVICE) =====
    if (!handled && (
      lowerSpeech.includes('explore') ||
      lowerSpeech.includes('portal') ||
      lowerSpeech.includes('not sure') ||
      lowerSpeech.includes('don\'t know') ||
      lowerSpeech.includes('dont know') ||
      lowerSpeech.includes('confused') ||
      lowerSpeech.includes('help me decide')
    )) {
      
      fastify.log.info("📋 SENDING SERVICE PORTAL");
      
      await respondWithNaturalVoice(response, "No problem! I'm texting you our service portal where you can explore all services and get personalized quotes.", tenant);
      
      const portalLink = "https://www.locrepair.com/service_portal";
      await sendLinksViaSMS(fromNumber, toNumber, [portalLink], tenant, 'service_portal');
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== PRIORITY 4: SERVICE QUESTIONS - DETECT INTENT FIRST =====
if (!handled) {
  const serviceKeywords = ['retwist', 'wick', 'interlock', 'sisterlock', 'sister lock', 
                           'microlock', 'crochet', 'bald coverage', 'bald spot', 
                           'repair', 'extension', 'starter locs'];
  
  let mentionedService = null;
  for (const keyword of serviceKeywords) {
    if (lowerSpeech.includes(keyword)) {
      mentionedService = keyword;
      break;
    }
  }
  
  if (mentionedService) {
    // DETECT INTENT
    const isInfoIntent = (
      lowerSpeech.includes('what are') ||
      lowerSpeech.includes('what is') ||
      lowerSpeech.includes('tell me about') ||
      lowerSpeech.includes('tell me more') ||
      lowerSpeech.includes('explain') ||
      lowerSpeech.includes('how do') ||
      lowerSpeech.includes('what\'s the difference') ||
      lowerSpeech.includes('do you offer') ||
      lowerSpeech.includes('do you do') ||
      lowerSpeech.includes('can you do') ||
      lowerSpeech.includes('more info') ||
      lowerSpeech.includes('learn about') ||
      lowerSpeech.includes('information about')
    );
    
    const isPricingIntent = (
      lowerSpeech.includes('how much') ||
      lowerSpeech.includes('cost') ||
      lowerSpeech.includes('price') ||
      lowerSpeech.includes('pricing') ||
      lowerSpeech.includes('get a quote') ||
      lowerSpeech.includes('quote for')
    );
    
    const isBookingIntent = (
      lowerSpeech.includes('book') ||
      lowerSpeech.includes('appointment') ||
      lowerSpeech.includes('schedule')
    );
    
    // HANDLE BASED ON INTENT
    if (isInfoIntent) {
      // INFO INTENT: Answer from knowledge, then offer quote
      fastify.log.info({ service: mentionedService }, "ℹ️ INFO INTENT - Using knowledge base");
      
      const knowledgeText = loadKnowledgeFor(tenant);
      const systemPrompt = buildVoicePrompt(tenant, knowledgeText);

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: speechResult }
        ],
        max_tokens: 200
      });

      const aiResponse = completion.choices?.[0]?.message?.content?.trim() || 
        "Let me help you with that.";
      
      await respondWithNaturalVoice(response, aiResponse, tenant);
      
      // OFFER QUOTE AFTER ANSWERING
      await respondWithNaturalVoice(response, `Would you like to get a personalized quote for ${mentionedService.replace('_', ' ')}?`, tenant);
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      handled = true;
      reply.type("text/xml").send(response.toString());
      return;
      
    } else if (isPricingIntent) {
      // PRICING INTENT: Send quote link immediately
      fastify.log.info({ service: mentionedService }, "💰 PRICING INTENT - Sending quote");
      
      let quoteLink = null;
      let serviceName = mentionedService;
      
      if (mentionedService === 'retwist') {
        quoteLink = "https://www.locrepair.com/retwist-quote/";
        serviceName = "retwist";
      } else if (mentionedService === 'wick') {
        quoteLink = "https://www.locrepair.com/wick-maintenance-quote/";
        serviceName = "wick locs";
      } else if (mentionedService.includes('bald')) {
        quoteLink = "https://www.locrepair.com/bald-quote-for-existing-locs/";
        serviceName = "bald coverage";
      } else if (mentionedService === 'repair') {
        quoteLink = "https://www.locrepair.com/repair-quote/";
        serviceName = "loc repair";
      } else if (mentionedService === 'crochet') {
        quoteLink = "https://www.locrepair.com/crochet-maintenance-quote";
        serviceName = "crochet maintenance";
      } else if (mentionedService === 'interlock') {
        quoteLink = "https://www.locrepair.com/interlocking-maintenance-quote/";
        serviceName = "interlock maintenance";
      } else if (mentionedService.includes('sisterlock') || mentionedService.includes('microlock')) {
        quoteLink = "https://www.locrepair.com/micro-sister-brother-locs-maintenance-quote/";
        serviceName = "sisterlock/microlock maintenance";
      } else if (mentionedService.includes('starter')) {
        quoteLink = "https://www.locrepair.com/starter-loc-quote";
        serviceName = "starter locs";
      } else if (mentionedService === 'extension') {
        quoteLink = "https://www.locrepair.com/permanent-loc-extensions-quote/";
        serviceName = "loc extensions";
      }
      
      if (quoteLink) {
        await respondWithNaturalVoice(response, `I'm texting you the ${serviceName} quote form. Fill it out to get personalized pricing.`, tenant);
        await sendLinksViaSMS(fromNumber, toNumber, [quoteLink], tenant, `${serviceName.replace(' ', '_')}_quote`);
        
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        
        await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
        
        handled = true;
        reply.type("text/xml").send(response.toString());
        return;
      }
      
    } else if (isBookingIntent) {
      // BOOKING INTENT: Trigger appointment flow
      fastify.log.info({ service: mentionedService }, "📅 BOOKING INTENT - Starting appointment flow");
      
      await respondWithNaturalVoice(response, "Are you a new client or a returning client?", tenant);
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      handled = true;
      reply.type("text/xml").send(response.toString());
      return;
    }
  }
}

// ===== HANDLE "YES" RESPONSES TO QUOTE OFFERS =====
if (!handled && (lowerSpeech.includes('yes') || lowerSpeech.includes('yeah') || 
    lowerSpeech.includes('sure') || lowerSpeech.includes('okay'))) {
  
  // If they said yes, ask what service they want a quote for
  await respondWithNaturalVoice(response, "Great! Which service would you like a quote for?", tenant);
  
  response.gather({
    input: "speech",
    action: "/handle-speech",
    method: "POST",
    timeout: 12,
    speechTimeout: "auto"
  });
  
  handled = true;
  reply.type("text/xml").send(response.toString());
  return;
}
    // ===== PRIORITY 5: RETURNING CLIENT RESPONSE =====
    if (!handled && (
      lowerSpeech.includes('returning') ||
      lowerSpeech.includes('been here before') ||
      lowerSpeech.includes('existing client') ||
      lowerSpeech.includes('regular') ||
      lowerSpeech.includes('come here before') ||
      lowerSpeech.includes('return')
    )) {
      
      fastify.log.info("🔄 RETURNING CLIENT DETECTED");
      
      await respondWithNaturalVoice(response, "Great! Since you're a returning client, what service do you usually get? I can send you a direct booking link.", tenant);
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== PRIORITY 6: RETURNING CLIENT - DIRECT BOOKING LINKS =====
    if (!handled) {
      let bookingLink = null;
      let serviceName = "";
      
      if (lowerSpeech.includes('retwist') || lowerSpeech.includes('palm roll')) {
        bookingLink = "https://locrepair.as.me/?appointmentType=83058786";
        serviceName = "retwist";
      } else if (lowerSpeech.includes('wick')) {
        bookingLink = "https://locrepair.as.me/?appointmentType=83060814";
        serviceName = "wick loc maintenance";
      } else if (lowerSpeech.includes('interlock')) {
        bookingLink = "https://locrepair.as.me/?appointmentType=83060708";
        serviceName = "interlock maintenance";
      } else if (lowerSpeech.includes('sisterlock') || lowerSpeech.includes('sister lock') || lowerSpeech.includes('microlock')) {
        bookingLink = "https://locrepair.as.me/?appointmentType=83060793";
        serviceName = "sisterlock maintenance";
      } else if (lowerSpeech.includes('crochet')) {
        bookingLink = "https://locrepair.as.me/?appointmentType=83060747";
        serviceName = "crochet roots maintenance";
      } else if (lowerSpeech.includes('bald')) {
        bookingLink = "https://locrepair.as.me/?appointmentType=83060933";
        serviceName = "bald coverage maintenance";
      }
      
      if (bookingLink) {
        fastify.log.info({ service: serviceName }, "📅 SENDING BOOKING LINK");
        
        await respondWithNaturalVoice(response, `Perfect! I'm texting you the direct booking link for your ${serviceName} appointment.`, tenant);
        await sendLinksViaSMS(fromNumber, toNumber, [bookingLink], tenant, `${serviceName.replace(' ', '_')}_booking`);
        
        response.gather({
          input: "speech",
          action: "/handle-speech",
          method: "POST",
          timeout: 12,
          speechTimeout: "auto"
        });
        
        await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
        
        reply.type("text/xml").send(response.toString());
        return;
      }
    }
    
    // ===== CONSULTATION REQUESTS =====
    if (!handled && lowerSpeech.includes('consultation')) {
      fastify.log.info("📋 CONSULTATION REQUEST");
      
      await respondWithNaturalVoice(response, "I'm texting you our consultation booking link.", tenant);
      
      const consultLink = "https://locrepair.as.me/?appointmentType=83061405";
      await sendLinksViaSMS(fromNumber, toNumber, [consultLink], tenant, 'consultation_booking');
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== HOURS INQUIRY =====
    if (!handled && (lowerSpeech.includes('hour') || lowerSpeech.includes('open') || lowerSpeech.includes('close'))) {
      await respondWithNaturalVoice(response, "We're open Sunday through Friday, 11 AM to 7 PM by appointment only. We're closed Saturdays. What service are you interested in?", tenant);
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== PRICING INQUIRY =====
    if (!handled && (lowerSpeech.includes('price') || lowerSpeech.includes('cost') || lowerSpeech.includes('how much'))) {
      await respondWithNaturalVoice(response, "Our pricing is quote-based since everyone's needs are different. I'm texting you our service portal where you can get personalized pricing.", tenant);
      
      const portalLink = "https://www.locrepair.com/service_portal";
      await sendLinksViaSMS(fromNumber, toNumber, [portalLink], tenant, 'service_portal');
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== TRAINING PROGRAM =====
    if (!handled && (lowerSpeech.includes('training') || lowerSpeech.includes('course') || lowerSpeech.includes('learn'))) {
      await respondWithNaturalVoice(response, "Yes, we offer a comprehensive loc repair training program for 49 dollars per week. You can text START to 313-455-5627 to enroll.", tenant);
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== LOCATION/ADDRESS =====
    if (!handled && (lowerSpeech.includes('address') || lowerSpeech.includes('location') || lowerSpeech.includes('where are you'))) {
      await respondWithNaturalVoice(response, "We're located at 25240 Lahser Road, Suite 9, Southfield, Michigan 48033. Parking is in the rear with handicap access.", tenant);
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== WEBSITE REQUEST =====
    if (!handled && (lowerSpeech.includes('website') || lowerSpeech.includes('web site') || lowerSpeech.includes('online'))) {
      await respondWithNaturalVoice(response, "I'm texting you our website link now.", tenant);
      
      const websiteLink = "https://www.locrepair.com";
      await sendLinksViaSMS(fromNumber, toNumber, [websiteLink], tenant, 'website');
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== INSTAGRAM REQUEST =====
    if (!handled && (lowerSpeech.includes('instagram') || lowerSpeech.includes('insta') || lowerSpeech.includes('social media'))) {
      await respondWithNaturalVoice(response, "I'm texting you our Instagram link now.", tenant);
      
      const instaLink = "https://www.instagram.com/locrepairexpert";
      await sendLinksViaSMS(fromNumber, toNumber, [instaLink], tenant, 'instagram');
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== RUNNING LATE =====
    if (!handled && (lowerSpeech.includes('running late') || lowerSpeech.includes('running behind') || lowerSpeech.includes('late for'))) {
      await respondWithNaturalVoice(response, "Thanks for the update! Yesha has been informed you're running behind.", tenant);
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== APPOINTMENT LOOKUP/MANAGEMENT =====
    if (!handled && (lowerSpeech.includes('check appointment') || lowerSpeech.includes('manage appointment') || 
        lowerSpeech.includes('cancel') || lowerSpeech.includes('reschedule'))) {
      
      const appointmentResult = await callAirtableAPI(tenant, 'lookup_appointments', { phone: fromNumber });
      
      await respondWithNaturalVoice(response, appointmentResult.speech, tenant);
      
      if (appointmentResult.handled) {
        const lookupLink = "https://www.locrepair.com/appointment-lookup.html";
        await sendLinksViaSMS(fromNumber, toNumber, [lookupLink], tenant, 'appointment_lookup');
      }
      
      response.gather({
        input: "speech",
        action: "/handle-speech",
        method: "POST",
        timeout: 12,
        speechTimeout: "auto"
      });
      
      await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
      
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== GOODBYE HANDLING =====
    if (lowerSpeech.includes('bye') || lowerSpeech.includes('goodbye') || 
        lowerSpeech.includes('that\'s all') || lowerSpeech.includes('nothing else') ||
        lowerSpeech.includes('no more') || lowerSpeech.includes('have a good day') ||
        (lowerSpeech.includes('no') && (lowerSpeech.includes('thank') || lowerSpeech.includes('good')))) {
      
      await respondWithNaturalVoice(response, "You're welcome! Have a great day!", tenant);
      response.hangup();
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== SIMPLE "NO" RESPONSE =====
    if (lowerSpeech.includes('no') && lowerSpeech.length <= 15 && 
        !lowerSpeech.includes('english') && !lowerSpeech.includes('problem')) {
      
      await respondWithNaturalVoice(response, "Looks like you're all set! Feel free to call back anytime. Have a great day!", tenant);
      response.hangup();
      reply.type("text/xml").send(response.toString());
      return;
    }
    
    // ===== FALLBACK: USE OPENAI FOR LOC KNOWLEDGE QUESTIONS =====
    // Only reaches here if NONE of the above matched
    fastify.log.info("💬 Using OpenAI for loc knowledge question");
    
    const knowledgeText = loadKnowledgeFor(tenant);
    const systemPrompt = buildVoicePrompt(tenant, knowledgeText);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: speechResult }
      ],
      max_tokens: 150
    });

    const aiResponse = completion.choices?.[0]?.message?.content?.trim() || 
      "I'm sorry, I couldn't process that right now.";
    
    await respondWithNaturalVoice(response, aiResponse, tenant);

    response.gather({
      input: "speech",
      action: "/handle-speech",
      method: "POST",
      timeout: 12,
      speechTimeout: "auto"
    });

    await respondWithNaturalVoice(response, "Is there anything else I can help you with?", tenant);
    
    reply.type("text/xml").send(response.toString());
    return;

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
    
    reply.type("text/xml").send(response.toString());
  }
});

// ---------------- START SERVER ----------------
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 LocSync Voice Bot - Loc Repair Clinic Edition running on ${address}`);
  console.log(`📞 Phone: 313-455-5627`);
  console.log(`🎤 ElevenLabs: ${process.env.ELEVENLABS_API_KEY ? "ENABLED ✅" : "Disabled"}`);
  console.log(`✨ Hardcoded flow for New vs Returning clients!`);
});
