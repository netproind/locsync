// index.js (ESM) — Fastify + Twilio Media Streams + OpenAI Realtime + Square (REST helpers)
// package.json must have: "type": "module"

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'node:fs/promises';
import { DateTime } from 'luxon';

import {
  listLocations,
  searchAvailability,
  createBooking,
  ensureCustomerByPhoneOrEmail,
  findServiceVariationIdByName,
  resolveCustomerIds,
  lookupUpcomingBookingsByPhoneOrEmail,
  retrieveBooking,
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
      txt = txt.slice(0, cap);
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

// ---------- DATE/TIME HELPERS ----------
function dayWindowUTC(isoDate) {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const startAt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0)).toISOString();
  const endAt = new Date(Date.UTC(y, m - 1, d, 23, 59, 59)).toISOString();
  return { startAt, endAt };
}

function speakTime(iso, tz = 'America/Detroit') {
  if (!iso) return '';
  let dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid || !dt.zoneName) dt = DateTime.fromISO(iso, { zone: tz });
  return dt.toZone(tz).toFormat("cccc, LLLL d 'at' h:mm a");
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

BOOKING (after a quote / or by request)
- Booking link: ${booking}
- For availability: call square_search_availability with the caller’s window and service.
- Offer 2–3 nearest slots. After they pick, call square_create_booking.

APPOINTMENT LOOKUP (find my appointment)
- Ask for the phone/email on file (name as fallback). If a specific day is mentioned, include { date: 'YYYY-MM-DD' }.
- Call square_find_booking. When 'spoken' is provided, read that exact string back as the time.
- Never guess times; use tenant timezone.

CANCEL / RESCHEDULE
- To cancel: confirm intent → square_cancel_booking → read back result.
- To reschedule: confirm desired time, check availability, then square_reschedule_booking → read back result.

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
    reply.send({ ok: true, locations: locations.map(l => ({ id: l.id, name: l.name })) });
  } catch (e) {
    reply.code(500).send({ ok: false, error: String(e?.message || e) });
  }
});

// --- DEV: find bookings by phone/email/name (+ optional date) ---
fastify.get('/dev/find', async (req, reply) => {
  try {
    const { phone, email, name, date } = req.query || {};
    const { locationId, teamMemberId } = sqDefaults();

    // split name → given/family
    let givenName, familyName;
    if (name) {
      const parts = String(name).trim().split(/\s+/);
      givenName = parts[0];
      familyName = parts.slice(1).join(' ') || undefined;
    }

    // optional day window
    let startAt, endAt;
    if (date) ({ startAt, endAt } = dayWindowUTC(date));

    // pull from Square (past + future), then narrow to window if provided
    const res = await lookupUpcomingBookingsByPhoneOrEmail({
      phone,
      email,
      givenName,
      familyName,
      locationId,
      teamMemberId,
      includePast: true
    });

    let list = res.bookings || [];
    if (startAt || endAt) {
      const s = startAt ? new Date(startAt).getTime() : -Infinity;
      const e = endAt   ? new Date(endAt).getTime()   :  Infinity;
      list = list.filter(b => {
        const t = new Date(b.start_at || b.startAt).getTime();
        return t >= s && t <= e;
      });
    }

    // normalize a compact view
    const tz = (Object.values(TENANTS)[0]?.timezone) || 'America/Detroit';
    const items = list
      .map(b => {
        const start = b.start_at || b.startAt;
        return {
          id: b.id,
          startAt: start,
          spoken: speakTime(start, tz),
          locationId: b.location_id || b.locationId,
          customerId: b.customer_id || b.customerId,
          status: b.status || 'BOOKED'
        };
      })
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

    reply.send({ ok: true, count: items.length, items });
  } catch (e) {
    reply.code(500).send({ ok: false, error: String(e?.message || e) });
  }
});

// --- DEV: retrieve one booking by id ---
fastify.get('/dev/booking/:id', async (req, reply) => {
  try {
    const b = await retrieveBooking(req.params.id);
    if (!b) return reply.code(404).send({ ok: false, error: 'Not found' });
    reply.send({ ok: true, booking: b });
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
  app.get('/media-stream', { websocket: true }, (connection) => {
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
    let chosenVoice   = DEFAULTS.voice;
    let selectedModel = DEFAULTS.model;
    let selectedTemp  = DEFAULTS.temperature;
    let selectedMods  = DEFAULTS.modalities;
    let selectedTurnDet = DEFAULTS.turn_detection;

    function maybeSendSessionUpdate() {
      if (!openAiWs || openAiWs.readyState !== WebSocket.OPEN) return;
      if (!(openAiReady && tenantReady)) return;

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
                  serviceName: { type: 'string', description: 'Friendly name; optional if default service variation env is set.' },
                  startAt: { type: 'string', description: 'ISO 8601 start datetime' },
                  endAt: { type: 'string', description: 'ISO 8601 end datetime' }
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
                  startAt: { type: 'string' },
                  serviceName: { type: 'string' },
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
              description: 'Look up bookings by phone, email, or name; optional single-day or custom window.',
              parameters: {
                type: 'object',
                properties: {
                  phone: { type: 'string' },
                  email: { type: 'string' },
                  name:  { type: 'string' },
                  date:  { type: 'string', description: 'yyyy-mm-dd (tenant timezone)' },
                  startAt: { type: 'string' },
                  endAt:   { type: 'string' }
                }
              }
            },
            {
              type: 'function',
              name: 'square_cancel_booking',
              description: 'Cancel a booking by bookingId, or by identifiers + optional date.',
              parameters: {
                type: 'object',
                properties: {
                  bookingId: { type: 'string' },
                  phone: { type: 'string' },
                  email: { type: 'string' },
                  name:  { type: 'string' },
                  date:  { type: 'string' }
                }
              }
            },
            {
              type: 'function',
              name: 'square_reschedule_booking',
              description: 'Reschedule a booking by bookingId or identifiers + date.',
              parameters: {
                type: 'object',
                properties: {
                  bookingId: { type: 'string' },
                  phone: { type: 'string' },
                  email: { type: 'string' },
                  name:  { type: 'string' },
                  date:  { type: 'string' },
                  newStartAt: { type: 'string', description: 'New ISO start time' }
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

          chosenVoice     = tenantRef?.voice || DEFAULTS.voice;
          selectedModel   = tenantRef?.model || DEFAULTS.model;
          selectedTemp    = tenantRef?.temperature ?? DEFAULTS.temperature;
          selectedMods    = Array.isArray(tenantRef?.modalities) ? tenantRef.modalities : DEFAULTS.modalities;
          selectedTurnDet = tenantRef?.turn_detection || DEFAULTS.turn_detection;
          currentKbCap    = tenantRef?.kb_per_file_char_cap || DEFAULTS.kb_per_file_char_cap;
          const instrCap  = tenantRef?.instructions_char_cap || DEFAULTS.instructions_char_cap;

          openAiReady = false;
          openAiWs = new WebSocket(
            `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(selectedModel)}`,
            { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
          );

          openAiWs.on('open', () => { openAiReady = true; maybeSendSessionUpdate(); });

          openAiWs.on('message', async (buf) => {
            let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }

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
                  if (!serviceVariationId) throw new Error('No service variation found. Set SQUARE_DEFAULT_SERVICE_VARIATION_ID or provide a matching Catalog service.');

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
                  if (!serviceVariationId) throw new Error('No service variation found. Set SQUARE_DEFAULT_SERVICE_VARIATION_ID or provide a matching Catalog service.');

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

                if (name === 'square_find_booking') {
                  const tz = tenantRef?.timezone || 'America/Detroit';

                  let startAt = args.startAt || null;
                  let endAt   = args.endAt   || null;
                  if (args.date && (!startAt || !endAt)) {
                    const win = dayWindowUTC(args.date);
                    startAt = startAt || win.startAt;
                    endAt   = endAt   || win.endAt;
                  }

                  let givenName, familyName;
                  if (args.name) {
                    const parts = String(args.name).trim().split(/\s+/);
                    givenName = parts[0];
                    familyName = parts.slice(1).join(' ') || undefined;
                  }

                  const res = await lookupUpcomingBookingsByPhoneOrEmail({
                    phone: args.phone,
                    email: args.email,
                    givenName,
                    familyName,
                    locationId,
                    teamMemberId,
                    includePast: true
                  });

                  let list = res.bookings || [];
                  if (startAt || endAt) {
                    const s = startAt ? new Date(startAt).getTime() : -Infinity;
                    const e = endAt   ? new Date(endAt).getTime()   :  Infinity;
                    list = list.filter(b => {
                      const t = new Date(b.start_at || b.startAt).getTime();
                      return t >= s && t <= e;
                    });
                  }

                  const formatted = list
                    .map(b => {
                      const start = b.start_at || b.startAt;
                      return {
                        bookingId: b.id,
                        startAt: start,
                        spoken: speakTime(start, tz),
                        locationId: b.location_id || b.locationId,
                        customerId: b.customer_id || b.customerId,
                        segments: (b.appointment_segments || b.appointmentSegments || []).map(s => ({
                          serviceVariationId: s.service_variation_id || s.serviceVariationId,
                          durationMinutes: s.duration_minutes ?? s.durationMinutes ?? null
                        }))
                      };
                    })
                    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
                    .slice(0, 10);

                  toolResult = { ok: true, bookings: formatted };
                }

                if (name === 'square_cancel_booking') {
                  let booking = null;

                  if (args.bookingId) {
                    booking = await retrieveBooking(args.bookingId);
                  } else {
                    let givenName, familyName;
                    if (args.name) {
                      const parts = String(args.name).trim().split(/\s+/);
                      givenName = parts[0];
                      familyName = parts.slice(1).join(' ') || undefined;
                    }
                    let w = { startAt: null, endAt: null };
                    if (args.date) w = dayWindowUTC(args.date);

                    const res = await lookupUpcomingBookingsByPhoneOrEmail({
                      phone: args.phone,
                      email: args.email,
                      givenName,
                      familyName,
                      locationId,
                      teamMemberId,
                      includePast: true
                    });

                    let list = res.bookings || [];
                    if (w.startAt || w.endAt) {
                      const s = w.startAt ? new Date(w.startAt).getTime() : -Infinity;
                      const e = w.endAt   ? new Date(w.endAt).getTime()   :  Infinity;
                      list = list.filter(b => {
                        const t = new Date(b.start_at || b.startAt).getTime();
                        return t >= s && t <= e;
                      });
                    }
                    list.sort((a, b) => new Date(a.start_at || a.startAt) - new Date(b.start_at || b.startAt));
                    booking = list[0] || null;
                  }

                  if (!booking) throw new Error('No matching booking found to cancel.');

                  const cancelled = await cancelBooking({
                    bookingId: booking.id,
                    version: booking.version
                  });

                  toolResult = {
                    ok: true,
                    booking: {
                      bookingId: cancelled.id,
                      startAt: cancelled.start_at || cancelled.startAt,
                      status: 'CANCELLED'
                    }
                  };
                }

                if (name === 'square_reschedule_booking') {
                  if (!args.newStartAt) throw new Error('newStartAt is required.');

                  let booking = null;

                  if (args.bookingId) {
                    booking = await retrieveBooking(args.bookingId);
                  } else {
                    let givenName, familyName;
                    if (args.name) {
                      const parts = String(args.name).trim().split(/\s+/);
                      givenName = parts[0];
                      familyName = parts.slice(1).join(' ') || undefined;
                    }
                    let w = { startAt: null, endAt: null };
                    if (args.date) w = dayWindowUTC(args.date);

                    const res = await lookupUpcomingBookingsByPhoneOrEmail({
                      phone: args.phone,
                      email: args.email,
                      givenName,
                      familyName,
                      locationId,
                      teamMemberId,
                      includePast: true
                    });

                    let list = res.bookings || [];
                    if (w.startAt || w.endAt) {
                      const s = w.startAt ? new Date(w.startAt).getTime() : -Infinity;
                      const e = w.endAt   ? new Date(w.endAt).getTime()   :  Infinity;
                      list = list.filter(b => {
                        const t = new Date(b.start_at || b.startAt).getTime();
                        return t >= s && t <= e;
                      });
                    }
                    list.sort((a, b) => new Date(a.start_at || a.startAt) - new Date(b.start_at || b.startAt));
                    booking = list[0] || null;
                  }

                  if (!booking) throw new Error('No matching booking found to reschedule.');

                  const updated = await rescheduleBooking({
                    bookingId: booking.id,
                    newStartAt: args.newStartAt
                  });

                  toolResult = {
                    ok: true,
                    booking: {
                      bookingId: updated.id,
                      startAt: updated.start_at || updated.startAt,
                      status: 'RESCHEDULED'
                    }
                  };
                }
              } catch (e) {
                toolResult = { ok: false, error: String(e?.message || e) };
              }

              openAiWs.send(JSON.stringify({
                type: 'response.function_call_output',
                call_id,
                output: JSON.stringify(toolResult)
              }));
              return;
            }

            if (msg.type === 'response.content.done') {
              const txt = (msg?.output_text || '').slice(0, 400);
              app.log.info({ preview: txt }, 'AI final text');
            }

            if (msg.type === 'response.audio.delta' && msg.delta && streamSid) {
              connection.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: msg.delta }
              }));

              if (!responseStartTimestampTwilio) {
                responseStartTimestampTwilio = latestMediaTimestamp;
              }
              if (msg.item_id) lastAssistantItem = msg.item_id;

              connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
              markQueue.push('responsePart');
            }

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
              audio: data.media?.payload
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
