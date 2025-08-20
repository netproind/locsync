// index.js (ESM) — Fastify + Twilio Media Streams + OpenAI Realtime + Square tools
// package.json must have: "type": "module"

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'node:fs/promises';

import {
  // Square helpers (exported from ./square.js)
  listLocations,
  searchAvailability,
  createBooking,
  ensureCustomerByPhoneOrEmail,
  findServiceVariationIdByName,
  resolveCustomerIds,
  lookupUpcomingBookingsByPhoneOrEmail, // <— use this (it exists in your square.js)
  retrieveBooking,                       // expects (bookingId)
  rescheduleBooking,
  cancelBooking
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

// ---------- DATE/TIME SPEECH HELPERS ----------
function dayWindowUTC(isoDate) {
  // Build UTC 00:00..23:59:59 window for the given date string (YYYY-MM-DD)
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const startAt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0)).toISOString();
  const endAt = new Date(Date.UTC(y, m - 1, d, 23, 59, 59)).toISOString();
  return { startAt, endAt };
}

function speakTime(iso, tz = 'America/Detroit') {
  const dt = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(dt);
}

// ---- tool-call watchdogs ----
function withTimeout(promise, ms, label = 'tool') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}
function say(openAiWs, text) {
  if (!openAiWs || openAiWs.readyState !== 1) return;
  openAiWs.send(JSON.stringify({
    type: 'response.create',
    response: { instructions: text }
  }));
}

// ---------- INSTRUCTIONS BUILDER ----------
function buildInstructions(tenant, kbText = '') {
  const style = tenant?.voice_style || 'warm, professional, concise';
  const services = Array.isArray(tenant?.services) ? tenant.services : [];
  const pricing = Array.isArray(tenant?.pricing_notes) ? tenant.pricing_notes : [];
  const policies = Array.isArray(tenant?.policies) ? tenant.policies : [];
  const studio = tenant?.studio_name || 'our studio';
  const booking = tenant?.booking_url || '(unset)';

  const canonical =
    (tenant?.canonical_answers || [])
      .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`)
      .join('\n') || '(none)';

  return (
    `You are the voice receptionist for "${studio}".
Tone & style: ${style}. Let callers interrupt naturally. Keep answers under 20 seconds.

GROUNDING & SOURCES
- Prefer tenant content and FAQ text below over anything else.
- If the question is not covered or you’re uncertain: ask a brief clarifying question, then stop.
- Never invent pricing, medical advice, or availability. If unsure, say you’ll confirm later.
- For policies, quote exactly; if not present in the KB, say you’ll check and follow up.

BOOKING (after a quote / or by request)
- Booking link: ${booking}
- For availability: call square_search_availability with the caller’s window and service.
- Offer 2–3 nearest slots. After they pick, call square_create_booking.

APPOINTMENT LOOKUP (find my appointment)
- If the caller asks for their appointment time/date, ask for the phone or email on file (name as fallback).
- If they mention a specific day, include { date: 'YYYY-MM-DD' }.
- Call square_find_booking. If multiple bookings are found, ask which one and then read the exact date/time.
- Never guess times. Read back clearly using the tenant timezone.

CANCEL / RESCHEDULE
- To cancel, confirm they want to cancel, then call square_cancel_booking.
- To reschedule, confirm a new requested day/time; check availability; then call square_reschedule_booking with the chosen new start time.
- Always read back the result (date/time). Do not promise to text.

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

// Dev: Square sanity ping (lists locations)
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

// Dev: quick customer→bookings check in browser
fastify.get('/dev/find', async (req, reply) => {
  try {
    const { phone, email, name, date } = req.query;
    const { locationId, teamMemberId } = sqDefaults();
    let startAt, endAt;
    if (date) ({ startAt, endAt } = dayWindowUTC(String(date)));

    const ids = await resolveCustomerIds({ phone, email, givenName: name, familyName: undefined });
    if (!ids.length) return reply.send({ ok: false, error: 'no customer' });

    // use the 1st match for this dev endpoint
    const { bookings } = await lookupUpcomingBookingsByPhoneOrEmail({
      phone, email, givenName: name, familyName: undefined,
      locationId, teamMemberId,
      includePast: true // show all for debugging
    });

    reply.send({ ok: true, count: bookings.length, sample: bookings.slice(0, 3) });
  } catch (e) {
    reply.code(500).send({ ok: false, error: String(e?.message || e) });
  }
});

// Twilio webhook: start bidirectional media stream and pass tenant key
fastify.all('/incoming-call', async (request, reply) => {
  const host = request.headers['host'];
  const toNumber = (request.body?.To || '').trim();
  const tenant = TENANTS[toNumber] || Object.values(TENANTS)[0] || null;

  const greeting =
    tenant?.greeting_tts ||
    `Thanks for calling ${tenant?.studio_name || 'our studio'}. Connecting...begin speaking now`;

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
    let chosenVoice = DEFAULTS.voice;
    let selectedModel = DEFAULTS.model;
    let selectedTemp = DEFAULTS.temperature;
    let selectedMods = DEFAULTS.modalities;
    let selectedTurnDet = DEFAULTS.turn_detection;

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
                  serviceName: { type: 'string', description: 'Friendly name, e.g. "Interlock 2-3 turns". If missing, SQUARE_DEFAULT_SERVICE_VARIATION_ID is used.' },
                  startAt: { type: 'string', description: 'ISO 8601 start datetime, e.g. 2025-08-20T15:00:00-04:00' },
                  endAt: { type: 'string', description: 'ISO 8601 end datetime, window to search' }
                },
                required: ['startAt', 'endAt']
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
                  serviceName: { type: 'string', description: 'Service name (optional if env default is set)' },
                  customerGivenName: { type: 'string' },
                  customerPhone: { type: 'string' },
                  customerEmail: { type: 'string' },
                  note: { type: 'string' }
                },
                required: ['startAt']
              }
            },
            {
              type: 'function',
              name: 'square_find_booking',
              description: 'Look up one or more bookings by phone, email, or name, optionally limited to a specific date.',
              parameters: {
                type: 'object',
                properties: {
                  phone: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  date: { type: 'string', description: 'yyyy-mm-dd (tenant timezone)' },
                  startAt: { type: 'string' },
                  endAt: { type: 'string' }
                }
              }
            },
            {
              type: 'function',
              name: 'square_cancel_booking',
              description: 'Cancel a booking by bookingId, or by customer identification + optional date.',
              parameters: {
                type: 'object',
                properties: {
                  bookingId: { type: 'string' },
                  phone: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  date: { type: 'string' }
                }
              }
            },
            {
              type: 'function',
              name: 'square_reschedule_booking',
              description: 'Reschedule a booking (change start time) by bookingId or by customer identification + date.',
              parameters: {
                type: 'object',
                properties: {
                  bookingId: { type: 'string' },
                  phone: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  date: { type: 'string' },
                  newStartAt: { type: 'string', description: 'New ISO start (e.g. 2025-08-20T15:00:00-04:00)' }
                },
                required: ['newStartAt']
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
          chosenVoice = tenantRef?.voice || DEFAULTS.voice;
          selectedModel = tenantRef?.model || DEFAULTS.model;
          selectedTemp = tenantRef?.temperature ?? DEFAULTS.temperature;
          selectedMods = Array.isArray(tenantRef?.modalities) ? tenantRef.modalities : DEFAULTS.modalities;
          selectedTurnDet = tenantRef?.turn_detection || DEFAULTS.turn_detection;
          currentKbCap = tenantRef?.kb_per_file_char_cap || DEFAULTS.kb_per_file_char_cap;
          const instructionsCap = tenantRef?.instructions_char_cap || DEFAULTS.instructions_char_cap;

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

            // Tool calls
            if (msg.type === 'response.function_call') {
              const { name, arguments: argsJson, call_id } = msg;
              let toolResult = null;

              try {
                const args = typeof argsJson === 'string' ? JSON.parse(argsJson) : (argsJson || {});
                const { locationId, teamMemberId } = sqDefaults();

                if (name === 'square_search_availability') {
                  let serviceVariationId = process.env.SQUARE_DEFAULT_SERVICE_VARIATION_ID || null;
                  if (!serviceVariationId && args.serviceName) {
                    serviceVariationId = await withTimeout(
                      findServiceVariationIdByName({ serviceName: args.serviceName }),
                      4000, 'findServiceVariationIdByName'
                    );
                  }
                  if (!serviceVariationId) throw new Error('No service variation found. Set SQUARE_DEFAULT_SERVICE_VARIATION_ID or provide a matching serviceName.');

                  const slots = await withTimeout(
                    searchAvailability({
                      locationId,
                      teamMemberId,
                      serviceVariationId,
                      startAt: args.startAt,
                      endAt: args.endAt
                    }),
                    8000, 'searchAvailability'
                  );

                  toolResult = { ok: true, slots };
                }

                if (name === 'square_create_booking') {
                  let serviceVariationId = process.env.SQUARE_DEFAULT_SERVICE_VARIATION_ID || null;
                  if (!serviceVariationId && args.serviceName) {
                    serviceVariationId = await withTimeout(
                      findServiceVariationIdByName({ serviceName: args.serviceName }),
                      4000, 'findServiceVariationIdByName'
                    );
                  }
                  if (!serviceVariationId) throw new Error('No service variation found. Set SQUARE_DEFAULT_SERVICE_VARIATION_ID or provide a matching serviceName.');

                  const customer = await withTimeout(
                    ensureCustomerByPhoneOrEmail({
                      givenName: args.customerGivenName,
                      phone: args.customerPhone,
                      email: args.customerEmail
                    }),
                    5000, 'ensureCustomerByPhoneOrEmail'
                  );

                  const booking = await withTimeout(
                    createBooking({
                      locationId,
                      teamMemberId,
                      customerId: customer?.id,
                      serviceVariationId,
                      startAt: args.startAt,
                      sellerNote: args.note || undefined
                    }),
                    8000, 'createBooking'
                  );

                  toolResult = { ok: true, booking };
                }

                if (name === 'square_find_booking') {
                  const tz = tenantRef?.timezone || 'America/Detroit';
                  let startAt = args.startAt || null;
                  let endAt = args.endAt || null;
                  if (args.date && (!startAt || !endAt)) {
                    const win = dayWindowUTC(args.date);
                    startAt = startAt || win.startAt;
                    endAt = endAt || win.endAt;
                  }

                  const ids = await withTimeout(
                    resolveCustomerIds({
                      email: args.email,
                      phone: args.phone,
                      givenName: args.name, // treat name as givenName fallback
                      familyName: undefined
                    }),
                    5000, 'resolveCustomerIds'
                  );

                  if (!ids.length) {
                    toolResult = { ok: false, error: 'No matching customer found.' };
                  } else {
                    // Use the convenience helper that you already have in square.js
                    const { bookings } = await withTimeout(
                      lookupUpcomingBookingsByPhoneOrEmail({
                        phone: args.phone,
                        email: args.email,
                        givenName: args.name,
                        familyName: undefined,
                        locationId,
                        teamMemberId,
                        includePast: true // caller might ask about past/tomorrow/etc.
                      }),
                      8000, 'lookupUpcomingBookingsByPhoneOrEmail'
                    );

                    // Constrain to window if provided
                    const filtered = (startAt && endAt)
                      ? bookings.filter(b => b.startAt >= startAt && b.startAt <= endAt)
                      : bookings;

                    filtered.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
                    const formatted = filtered.slice(0, 10).map(b => ({
                      bookingId: b.id,
                      startAt: b.startAt,
                      spoken: speakTime(b.startAt, tz),
                      locationId: b.locationId,
                      customerId: b.customerId,
                      segments: (b.appointmentSegments || []).map(s => ({
                        serviceVariationId: s.serviceVariationId,
                        durationMinutes: s.durationMinutes ?? null
                      }))
                    }));
                    toolResult = { ok: true, bookings: formatted };
                  }
                }

                if (name === 'square_cancel_booking') {
                  let booking = null;
                  if (args.bookingId) {
                    booking = await withTimeout(
                      retrieveBooking(args.bookingId), // correct signature
                      6000, 'retrieveBooking'
                    );
                  } else {
                    const ids = await withTimeout(
                      resolveCustomerIds({ email: args.email, phone: args.phone, givenName: args.name, familyName: undefined }),
                      5000, 'resolveCustomerIds'
                    );
                    let startAt, endAt;
                    if (args.date) ({ startAt, endAt } = dayWindowUTC(args.date));
                    const { bookings } = await withTimeout(
                      lookupUpcomingBookingsByPhoneOrEmail({
                        phone: args.phone,
                        email: args.email,
                        givenName: args.name,
                        familyName: undefined,
                        locationId,
                        teamMemberId,
                        includePast: true
                      }),
                      8000, 'lookupUpcomingBookingsByPhoneOrEmail'
                    );
                    const narrowed = (startAt && endAt)
                      ? bookings.filter(b => b.startAt >= startAt && b.startAt <= endAt)
                      : bookings;
                    narrowed.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
                    booking = narrowed[0] || null;
                  }

                  if (!booking) throw new Error('No matching booking found to cancel.');
                  const cancelled = await withTimeout(
                    cancelBooking({ bookingId: booking.id, version: booking.version }),
                    8000, 'cancelBooking'
                  );
                  toolResult = { ok: true, booking: { bookingId: cancelled.id, startAt: cancelled.startAt, status: 'CANCELLED' } };
                }

                if (name === 'square_reschedule_booking') {
                  if (!args.newStartAt) throw new Error('newStartAt is required.');

                  let booking = null;
                  if (args.bookingId) {
                    booking = await withTimeout(
                      retrieveBooking(args.bookingId), // correct signature
                      6000, 'retrieveBooking'
                    );
                  } else {
                    const ids = await withTimeout(
                      resolveCustomerIds({ email: args.email, phone: args.phone, givenName: args.name, familyName: undefined }),
                      5000, 'resolveCustomerIds'
                    );
                    let startAt, endAt;
                    if (args.date) ({ startAt, endAt } = dayWindowUTC(args.date));
                    const { bookings } = await withTimeout(
                      lookupUpcomingBookingsByPhoneOrEmail({
                        phone: args.phone,
                        email: args.email,
                        givenName: args.name,
                        familyName: undefined,
                        locationId,
                        teamMemberId,
                        includePast: true
                      }),
                      8000, 'lookupUpcomingBookingsByPhoneOrEmail'
                    );
                    const narrowed = (startAt && endAt)
                      ? bookings.filter(b => b.startAt >= startAt && b.startAt <= endAt)
                      : bookings;
                    narrowed.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
                    booking = narrowed[0] || null;
                  }

                  if (!booking) throw new Error('No matching booking found to reschedule.');
                  const updated = await withTimeout(
                    rescheduleBooking({ bookingId: booking.id, newStartAt: args.newStartAt }),
                    8000, 'rescheduleBooking'
                  );
                  toolResult = { ok: true, booking: { bookingId: updated.id, startAt: updated.startAt, status: 'RESCHEDULED' } };
                }
              } catch (e) {
                toolResult = { ok: false, error: String(e?.message || e) };
                // Speak a graceful fallback so it never hangs
                say(openAiWs, "Sorry — I couldn’t pull that up just now. Can I confirm the phone number or email on your profile and try again?");
              }

              // return tool result to model
              openAiWs.send(JSON.stringify({
                type: 'response.function_call_output',
                call_id,
                output: JSON.stringify(toolResult)
              }));
              return;
            }

            // Normal content logs
            if (msg.type === 'response.content.done') {
              const txt = (msg?.output_text || '').slice(0, 400);
              app.log.info({ preview: txt }, 'AI final text');
            }

            // Audio back to Twilio
            if (msg.type === 'response.audio.delta' && msg.delta && streamSid) {
              connection.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: msg.delta } // base64 g711_ulaw
              }));

              if (!responseStartTimestampTwilio) {
                responseStartTimestampTwilio = latestMediaTimestamp;
              }
              if (msg.item_id) lastAssistantItem = msg.item_id;

              connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
              markQueue.push('responsePart');
            }

            // Caller barged in — truncate assistant audio
            if (msg.type === 'input_audio_buffer.speech_started') {
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
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
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
          let instructionsCap = tenantRef?.instructions_char_cap || DEFAULTS.instructions_char_cap;
          instructions = tenantRef ? buildInstructions(tenantRef, kbText) : 'You are a helpful salon receptionist.';
          if (instructions.length > instructionsCap) instructions = instructions.slice(0, instructionsCap);

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
