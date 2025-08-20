// index.js (ESM) — Fastify + Twilio Media Streams + OpenAI Realtime + Square tools
// package.json must have: "type": "module"

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'node:fs/promises';

import {
  searchAvailability,
  createBooking,
  ensureCustomerByPhoneOrEmail,
  findServiceVariationIdByName,
  listLocations,
  lookupUpcomingBookingsByPhoneOrEmail   // NEW
} from './square.js';

// ---------- ENV ----------
dotenv.config();
const { OPENAI_API_KEY, NODE_ENV } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY (set in Render → Environment).');
  process.exit(1);
}

// ---------- DEFAULTS ----------
const DEFAULTS = {
  voice: 'alloy',
  model: 'gpt-4o-realtime-preview-2024-10-01',
  temperature: 0.7,
  modalities: ['text', 'audio'],
  turn_detection: { type: 'server_vad' },
  kb_per_file_char_cap: 10000,
  instructions_char_cap: 24000,
  greeting_tts: null
};

// ---------- PORT ----------
const PORT = process.env.PORT || 5050; // Render injects PORT

// ---------- GLOBAL OVERRIDES (optional) ----------
let OVERRIDES = [];
try {
  const rawOv = await fs.readFile(new URL('./overrides.json', import.meta.url));
  OVERRIDES = JSON.parse(String(rawOv));
} catch {
  OVERRIDES = [];
}
OVERRIDES = Array.isArray(OVERRIDES)
  ? OVERRIDES.filter(o => o && typeof o.match === 'string' && typeof o.reply === 'string')
  : [];

// ---------- TENANTS (robust loader: tenants.js → Tenants.js → tenants.json) ----------
let TENANTS = {};
try {
  const mod = await import('./tenants.js');
  TENANTS = mod?.default || mod?.TENANTS || {};
} catch {
  try {
    const mod2 = await import('./Tenants.js');
    TENANTS = mod2?.default || mod2?.TENANTS || {};
  } catch {
    try {
      const raw = await fs.readFile(new URL('./tenants.json', import.meta.url));
      TENANTS = JSON.parse(String(raw));
    } catch {
      console.warn('No tenants file found (tenants.js / Tenants.js / tenants.json); using empty {}');
      TENANTS = {};
    }
  }
}

// ---------- KB HELPERS ----------
const kbCache = new Map(); // url -> text
let currentKbCap = DEFAULTS.kb_per_file_char_cap;

async function fetchKbText(urls = []) {
  let combined = '';
  for (const url of urls) {
    try {
      if (kbCache.has(url)) {
        combined += '\n\n' + kbCache.get(url);
        continue;
      }
      const res = await fetch(url);
      if (!res.ok) continue;
      let txt = await res.text();
      const cap = currentKbCap || DEFAULTS.kb_per_file_char_cap;
      txt = txt.slice(0, cap); // per-file cap
      kbCache.set(url, txt);
      combined += '\n\n' + txt;
    } catch {
      // ignore single-file failures
    }
  }
  return combined.trim();
}

function sqDefaults() {
  return {
    locationId: process.env.SQUARE_DEFAULT_LOCATION_ID,
    teamMemberId: process.env.SQUARE_DEFAULT_TEAM_MEMBER_ID
  };
}
// ---------- INSTRUCTIONS BUILDER ----------
function buildInstructions(tenant, kbText = '') {
  const style    = tenant?.voice_style || 'warm, professional, concise';
  const services = Array.isArray(tenant?.services) ? tenant.services : [];
  const pricing  = Array.isArray(tenant?.pricing_notes) ? tenant.pricing_notes : [];
  const policies = Array.isArray(tenant?.policies) ? tenant.policies : [];
  const studio   = tenant?.studio_name || 'our studio';
  const booking  = tenant?.booking_url || '(unset)';

  const canonical = (tenant?.canonical_answers || [])
    .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`)
    .join('\n') || '(none)';

  // Helper phrasing hint for speaking links clearly
  const spokenBookingHint = booking === '(unset)'
    ? '(booking link not set)'
    : `When reading this aloud, say it slowly and clearly. If it has slashes/underscores, read them out, e.g., "locrepair dot com slash service underscore portal".`;

  return (
`You are the voice receptionist for "${studio}".
Tone & style: ${style}. Let callers interrupt naturally. Keep answers under 20 seconds.

HARD RULES ABOUT COMMUNICATION
- Do NOT offer to text or email anything. Never say you'll send a link or message.
- Always provide information verbally. If a caller asks for a link, read it aloud slowly and clearly.
- If the caller asks you to repeat, repeat calmly and slowly.
- If you aren't sure of an answer, ask a brief clarifying question. Do not promise to follow up by text/email.

GROUNDING & SOURCES
- Prefer tenant content and FAQ text below over anything else.
- Never invent pricing, medical advice, or availability. If unsure, say you’ll check with the team.

BOOKING
- Booking link: ${booking}
- ${spokenBookingHint}
- For availability and booking, use the Square tools; do not guess times.
- If the caller gives a day/time window, first call square_search_availability, then offer 2–3 nearest slots; after they pick, call square_create_booking.

SERVICES
- ${services.join(', ')}

PRICING NOTES
- ${pricing.join(' | ')}

POLICIES
- ${policies.join(' | ')}

CANONICAL Q&A (authoritative; use verbatim where applicable):
${canonical}

TENANT FAQ TEXT (preferred over external knowledge):
${kbText || '(none)'}

SAFETY
- Do not give medical advice; recommend seeing a dermatologist if asked.
- Be concise; avoid speculation.`
  ).trim();
}

// ---------- FASTIFY ----------
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Health check for Render
fastify.get('/', async (_req, reply) => {
  reply.type('text/plain').send('OK');
});

// Dev: Square sanity ping
fastify.get('/dev/square/ping', async (_req, reply) => {
  try {
    const locations = await listLocations();
    reply.send({
      ok: true,
      locations: locations.map(l => ({ id: l.id, name: l.name }))
    });
  } catch (e) {
    reply.code(500).send({ ok: false, error: String(e?.message || e) });
  }
});

// Twilio webhook: start bidirectional media stream and pass tenant key
fastify.all('/incoming-call', async (request, reply) => {
  const host = request.headers['host'];
  const toNumber = (request.body?.To || '').trim();
  const tenant = TENANTS[toNumber] || Object.values(TENANTS)[0] || null;

  const greeting = tenant?.greeting_tts
    || `Thanks for calling ${tenant?.studio_name || 'our studio'}. Connecting...begin speaking now`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${greeting}</Say>
  <Pause length="1"/>
  <Connect>
    <Stream url="wss://${host}/media-stream">
      <Parameter name="tenant" value="${encodeURIComponent(toNumber)}"/>
    </Stream>
  </Connect>
</Response>`.trim();

  reply.type('text/xml').send(twiml);
});

// Media Streams WebSocket endpoint
fastify.register(async function (app) {
  app.get('/media-stream', { websocket: true }, (connection /* WS */) => {
    app.log.info('Twilio Media Stream connected');

    // -------- per-connection state --------
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    let openAiWs = null;
    let openAiReady = false;
    let tenantReady = false;
    let instructions = '';

    let tenantRef = null;
    let chosenVoice      = DEFAULTS.voice;
    let selectedModel    = DEFAULTS.model;
    let selectedTemp     = DEFAULTS.temperature;
    let selectedMods     = DEFAULTS.modalities;
    let selectedTurnDet  = DEFAULTS.turn_detection;

    function maybeSendSessionUpdate() {
      if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return;
      if (!(openAiReady && tenantReady)) return;

      // Merge global + per-tenant overrides once
      const tenantOverrides = Array.isArray(tenantRef?.overrides) ? tenantRef.overrides : [];
      const allOverrides = [...OVERRIDES, ...tenantOverrides];

      if (allOverrides.length && !instructions.includes('HARD OVERRIDES (highest priority):')) {
        const hard = allOverrides
          .map(o => `IF the user utterance matches /${o.match}/ THEN reply exactly: "${o.reply}"`)
          .join('\n');
        instructions += `\n\nHARD OVERRIDES (highest priority):\n${hard}`;
      }

      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: selectedTurnDet,
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: chosenVoice,
          instructions,
          modalities: selectedMods,
          temperature: selectedTemp,
          tools: [
            {
              type: 'function',
              name: 'square_search_availability',
              description: 'Searches open appointment slots for a given service and date range.',
              parameters: {
                type: 'object',
                properties: {
                  serviceName: { type: 'string', description: 'Human-friendly service name, e.g. "Interlock 2-3 turns". If missing, the default service variation env var will be used.' },
                  startAt: { type: 'string', description: 'ISO 8601 start datetime, e.g. 2025-08-20T15:00:00-04:00' },
                  endAt: { type: 'string', description: 'ISO 8601 end datetime, window to search' }
                },
                required: ['startAt', 'endAt']
              }
            },
            {
  type: 'function',
  name: 'square_lookup_booking',
  description: 'Look up the caller’s upcoming appointments by phone, email, or name. Returns the next upcoming booking(s).',
  parameters: {
    type: 'object',
    properties: {
      customerPhone: { type: 'string', description: 'E.164 like +13135551234 or US 10 digits; other punctuation allowed.' },
      customerEmail: { type: 'string', description: 'Customer email (case-insensitive).' },
      customerGivenName: { type: 'string', description: 'First name, if provided instead of phone/email.' },
      customerFamilyName: { type: 'string', description: 'Last name, optional for disambiguation.' },
      includePast: { type: 'boolean', description: 'If true, also return past bookings (sorted by startAt).' }
    }
  }
            },
            {
              type: 'function',
              name: 'square_create_booking',
              description: 'Creates a booking for the selected slot and caller.',
              parameters: {
                type: 'object',
                properties: {
                  startAt: { type: 'string', description: 'Chosen start datetime in ISO 8601' },
                  serviceName: { type: 'string', description: 'Service name; used to look up the service variation ID if needed' },
                  customerGivenName: { type: 'string' },
                  customerPhone: { type: 'string' },
                  customerEmail: { type: 'string' },
                  note: { type: 'string' }
                },
                required: ['startAt']
              }
            }
          ]
        }
      };
      openAiWs.send(JSON.stringify(sessionUpdate));
    }

    // ---- Twilio → events/audio ----
    connection.on('message', async (raw) => {
      let data;
      try { data = JSON.parse(raw); } catch { return; }

      switch (data.event) {
        case 'start': {
          streamSid = data.start?.streamSid;
          latestMediaTimestamp = 0;
          responseStartTimestampTwilio = null;

          const tenantKey = decodeURIComponent(data.start?.customParameters?.tenant || '');
          tenantRef = TENANTS[tenantKey] || Object.values(TENANTS)[0] || null;

          // choose per-tenant config (with defaults)
          chosenVoice      = tenantRef?.voice || DEFAULTS.voice;
          selectedModel    = tenantRef?.model || DEFAULTS.model;
          selectedTemp     = (tenantRef?.temperature ?? DEFAULTS.temperature);
          selectedMods     = Array.isArray(tenantRef?.modalities) ? tenantRef.modalities : DEFAULTS.modalities;
          selectedTurnDet  = tenantRef?.turn_detection || DEFAULTS.turn_detection;
          currentKbCap     = tenantRef?.kb_per_file_char_cap || DEFAULTS.kb_per_file_char_cap;

          // Connect OpenAI Realtime for this call
          openAiReady = false;
          openAiWs = new WebSocket(
            `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(selectedModel)}`,
            { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
          );

          // ---- OpenAI WS handlers ----
          openAiWs.on('open', () => { openAiReady = true; maybeSendSessionUpdate(); });

          openAiWs.on('message', async (buf) => {
            let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

            // Handle function/tool calls from Realtime
            if (msg.type === 'response.function_call') {
              const { name, arguments: argsJson, call_id } = msg;
              let toolResult = null;

              try {
                const args = typeof argsJson === 'string' ? JSON.parse(argsJson) : (argsJson || {});
                const { locationId, teamMemberId } = sqDefaults();

                if (name === 'square_search_availability') {
                  let serviceVariationId = process.env.SQUARE_DEFAULT_SERVICE_VARIATION_ID || null;
                  if (!serviceVariationId && args.serviceName) {
                    serviceVariationId = await findServiceVariationIdByName({ serviceName: args.serviceName });
                  }
                  if (!serviceVariationId) throw new Error('No service variation found. Set SQUARE_DEFAULT_SERVICE_VARIATION_ID or provide a serviceName that matches a Catalog item.');

                  const slots = await searchAvailability({
                    locationId,
                    teamMemberId,
                    serviceVariationId,
                    startAt: args.startAt,
                    endAt: args.endAt
                  });

                  toolResult = { ok: true, slots };
                }

                if (name === 'square_create_booking') {
                  let serviceVariationId = process.env.SQUARE_DEFAULT_SERVICE_VARIATION_ID || null;
                  if (!serviceVariationId && args.serviceName) {
                    serviceVariationId = await findServiceVariationIdByName({ serviceName: args.serviceName });
                  }
                  if (!serviceVariationId) throw new Error('No service variation found. Set SQUARE_DEFAULT_SERVICE_VARIATION_ID or provide a serviceName that matches a Catalog item.');

                  const customer = await ensureCustomerByPhoneOrEmail({
                    givenName: args.customerGivenName,
                    phone: args.customerPhone,
                    email: args.customerEmail
                  });

                  const booking = await createBooking({
                    locationId,
                    teamMemberId,
                    customerId: customer?.id,
                    serviceVariationId,
                    startAt: args.startAt,
                    sellerNote: args.note || undefined
                  });

                  toolResult = { ok: true, booking };
                }
              } catch (e) {
                toolResult = { ok: false, error: String(e?.message || e) };
              }

              // Send tool result back so the model can continue speaking
              openAiWs.send(JSON.stringify({
                type: 'response.function_call_output',
                call_id,
                output: JSON.stringify(toolResult)
              }));
              return; // stop further processing on this message
            }

            if (msg.type === 'response.content.done') {
              const txt = (msg?.output_text || '').slice(0, 400);
              app.log.info({ preview: txt }, 'AI final text');
            }

            if (msg.type === 'response.audio.delta' && msg.delta && streamSid) {
              // audio back to Twilio
              connection.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: msg.delta } // base64 g711_ulaw
              }));

              if (!responseStartTimestampTwilio) {
                responseStartTimestampTwilio = latestMediaTimestamp;
              }
              if (msg.item_id) lastAssistantItem = msg.item_id;

              // optional mark for playback boundary
              connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
              markQueue.push('responsePart');
            }

            if (msg.type === 'input_audio_buffer.speech_started') {
              // truncate assistant audio if caller starts talking
              if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                if (lastAssistantItem) {
                  openAiWs.send(JSON.stringify({
                    type: 'conversation.item.truncate',
                    item_id: lastAssistantItem,
                    content_index: 0,
                    audio_end_ms: latestMediaTimestamp - responseStartTimestampTwilio
                  }));
                }
                connection.send(JSON.stringify({ event: 'clear', streamSid }));
                markQueue = []; lastAssistantItem = null; responseStartTimestampTwilio = null;
              }
            }
          });

          openAiWs.on('error', (err) => app.log.error({ err }, 'OpenAI WS error'));
          openAiWs.on('close', () => app.log.info('OpenAI WS closed'));

          // load KB and build instructions
          let kbText = '';
          if (tenantRef?.faq_urls?.length) {
            kbText = await fetchKbText(tenantRef.faq_urls);
          }
          let instrCap = tenantRef?.instructions_char_cap || DEFAULTS.instructions_char_cap;
          instructions = tenantRef ? buildInstructions(tenantRef, kbText) : 'You are a helpful salon receptionist.';
          if (instructions.length > instrCap) instructions = instructions.slice(0, instrCap);

          tenantReady = true;
          maybeSendSessionUpdate();
          break;
        }

        case 'media': {
          latestMediaTimestamp = data.media?.timestamp ?? latestMediaTimestamp;
          if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: data.media?.payload // base64 g711_ulaw
            }));
          }
          break;
        }

        case 'mark': {
          if (markQueue.length > 0) markQueue.shift();
          break;
        }

        case 'stop': {
          app.log.info('Media stream stopped');
          break;
        }

        default:
          app.log.info({ event: data.event }, 'Twilio event');
      }
    });

    connection.on('close', () => {
      app.log.info('Twilio WS disconnected');
      if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });
  });
});

// ---------- START ----------
try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`Server is listening on port ${PORT} (${NODE_ENV || 'dev'})`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
