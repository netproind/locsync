// index.js — Fastify + Twilio Media Streams + OpenAI Realtime + Square (SDK) + Tenants + Knowledge
import Fastify from 'fastify';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'node:fs/promises';
import twilio from 'twilio';
import WebSocket from 'ws';

import { toE164US, squareClient } from './square.js';

dotenv.config();

// ---------- ENV ----------
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}
const PORT = process.env.PORT || 5050;
const DEFAULT_TZ = 'America/Detroit';
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-10-01';
const VOICE = process.env.OPENAI_VOICE || 'alloy';
const { customersApi, bookingsApi, catalogApi } = squareClient;

// ---------- Tenants ----------
let TENANTS = {};
try {
  const raw = await fs.readFile(new URL('./tenants.json', import.meta.url));
  TENANTS = JSON.parse(String(raw));
} catch {
  TENANTS = {};
}

// ---------- Knowledge ----------
async function loadKnowledge() {
  try {
    const raw = await fs.readFile(new URL('./knowledge.md', import.meta.url));
    return String(raw).slice(0, 24000);
  } catch {
    return '';
  }
}

// ---------- Utils ----------
function speakTime(iso, tz = DEFAULT_TZ) {
  if (!iso) return '';
  const dt = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(dt);
}

function dayWindowUTC(yyyy_mm_dd) {
  const [y, m, d] = yyyy_mm_dd.split('-').map(Number);
  const startAt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0)).toISOString();
  const endAt   = new Date(Date.UTC(y, m - 1, d, 23, 59, 59)).toISOString();
  return { startAt, endAt };
}

// ---------- Square helper logic (inline; uses squareClient) ----------
async function ensureCustomerByPhoneOrEmail({ phone, email, givenName, familyName }) {
  // Try exact match search
  try {
    const q = { query: { filter: {} } };
    if (phone) q.query.filter.phoneNumber = { exact: phone };
    if (email) q.query.filter.emailAddress = { exact: email };

    if (phone || email) {
      const res = await customersApi.searchCustomers(q);
      const hit = res?.result?.customers?.[0];
      if (hit) return hit;
    }
  } catch {}

  // Create if not found
  const created = await customersApi.createCustomer({
    givenName: givenName || 'Caller',
    familyName: familyName || undefined,
    phoneNumber: phone || undefined,
    emailAddress: email || undefined,
  });
  return created.result.customer;
}

async function findServiceVariationIdByName(serviceName) {
  // Use searchCatalogItems if available; else fallback to list + filter
  try {
    // Some SDKs: catalogApi.searchCatalogItems({ textFilter: serviceName })
    if (catalogApi.searchCatalogItems) {
      const res = await catalogApi.searchCatalogItems({ textFilter: serviceName });
      const items = res?.result?.items || [];
      for (const it of items) {
        const vars = it?.itemData?.variations || [];
        if (vars[0]?.id) return vars[0].id;
      }
    }
  } catch {}
  // Fallback: list and scan
  const listed = await catalogApi.listCatalog(undefined, 'ITEM');
  const objs = listed?.result?.objects || [];
  for (const obj of objs) {
    const name = obj?.itemData?.name || '';
    if (name.toLowerCase().includes(String(serviceName || '').toLowerCase())) {
      const vars = obj?.itemData?.variations || [];
      if (vars[0]?.id) return vars[0].id;
    }
  }
  return null;
}

async function getServiceVariationVersion(serviceVariationId) {
  // Grab catalog object directly to get version
  const res = await catalogApi.retrieveCatalogObject(serviceVariationId, false);
  return res?.result?.object?.version ?? null;
}

async function squareSearchAvailability({ locationId, teamMemberId, serviceName, startAt, endAt }) {
  const serviceVariationId = await findServiceVariationIdByName(serviceName);
  if (!serviceVariationId) throw new Error('Service not found. Please specify a known service.');

  const body = {
    query: {
      filter: {
        locationId,
        startAtRange: { startAt, endAt },
        segmentFilters: [
          {
            serviceVariationId,
            teamMemberIdFilter: { any: [teamMemberId] },
          },
        ],
      },
    },
  };
  const res = await bookingsApi.searchAvailability(body);
  return res?.result?.availabilities || [];
}

async function squareCreateBooking({ locationId, teamMemberId, startAt, serviceName, customerGivenName, customerPhone, customerEmail, note }) {
  const normalizedPhone = customerPhone ? toE164US(customerPhone) : null;
  const customer = await ensureCustomerByPhoneOrEmail({
    phone: normalizedPhone,
    email: customerEmail?.trim()?.toLowerCase(),
    givenName: customerGivenName,
  });

  const serviceVariationId = await findServiceVariationIdByName(serviceName);
  if (!serviceVariationId) throw new Error('Service not found for booking.');
  const serviceVariationVersion = await getServiceVariationVersion(serviceVariationId);
  if (serviceVariationVersion == null) throw new Error('Service variation version not found.');

  const req = {
    booking: {
      locationId,
      startAt,
      customerId: customer.id,
      appointmentSegments: [
        {
          serviceVariationId,
          serviceVariationVersion,
          teamMemberId,
          // duration is derived from variation; Square ignores if provided
        },
      ],
      sellerNote: note || undefined,
    },
  };

  const res = await bookingsApi.createBooking(req);
  return res?.result?.booking;
}

async function squareLookupBookings({ locationId, teamMemberId, phone, email, name, date, includePast = true }) {
  let givenName, familyName;
  if (name) {
    const parts = String(name).trim().split(/\s+/);
    givenName = parts[0];
    familyName = parts.slice(1).join(' ') || undefined;
  }

  const normalizedPhone = phone ? toE164US(phone) : null;
  const customer = await ensureCustomerByPhoneOrEmail({
    phone: normalizedPhone,
    email: email?.trim()?.toLowerCase(),
    givenName,
    familyName,
  });

  if (!customer?.id) return [];

  // Build a 31-day window centered on now (includePast=true => now-31d .. now+31d)
  const now = new Date();
  const start = new Date(now);
  if (includePast) start.setDate(start.getDate() - 31);
  const end = new Date(start);
  end.setDate(end.getDate() + 31);

  // If specific date provided, narrow to day window
  let startAtMin = start.toISOString();
  let startAtMax = end.toISOString();
  if (date) {
    const w = dayWindowUTC(date);
    startAtMin = w.startAt;
    startAtMax = w.endAt;
  }

  const body = {
    query: {
      filter: {
        customerIds: [customer.id],
        startAtRange: { startAt: startAtMin, endAt: startAtMax },
        // locationId/teamMemberId optional; include if you need to narrow
        ...(locationId ? { locationId } : {}),
        ...(teamMemberId ? { teamMemberId } : {}),
      },
      sort: { sortField: 'START_AT', order: 'ASC' },
    },
    limit: 100,
  };

  const res = await bookingsApi.searchBookings(body);
  return res?.result?.bookings || [];
}

async function squareRetrieveBooking(bookingId) {
  const res = await bookingsApi.retrieveBooking(bookingId);
  return res?.result?.booking;
}

async function squareCancelBooking(bookingId) {
  const current = await squareRetrieveBooking(bookingId);
  if (!current) throw new Error('Booking not found.');
  const req = { bookingVersion: current.version };
  await bookingsApi.cancelBooking(bookingId, req);
  return true;
}

async function squareRescheduleBooking(bookingId, newStartAt) {
  const current = await squareRetrieveBooking(bookingId);
  if (!current) throw new Error('Booking not found.');

  const req = {
    booking: {
      id: current.id,
      version: current.version, // optimistic concurrency
      locationId: current.locationId,
      customerId: current.customerId,
      startAt: newStartAt,
      appointmentSegments: (current.appointmentSegments || []).map(s => ({
        serviceVariationId: s.serviceVariationId,
        serviceVariationVersion: s.serviceVariationVersion,
        teamMemberId: s.teamMemberId,
      })),
    },
  };

  const res = await bookingsApi.updateBooking(bookingId, req);
  return res?.result?.booking;
}

// ---------- Instructions ----------
async function buildInstructions(tenant) {
  const kb = await loadKnowledge();
  const style = tenant?.voice_style || 'warm, professional, concise';
  const studio = tenant?.studio_name || 'our studio';
  const booking = tenant?.booking_url || '(no booking url)';
  const services = Array.isArray(tenant?.services) ? tenant.services.join(', ') : '(unspecified)';

  return `
You are the AI receptionist for "${studio}".
Tone & style: ${style}. Keep answers under 20 seconds. Do not fabricate prices or availability.

Knowledge (preferred source):
${kb || '(none)'}

Booking Portal: ${booking}
Services: ${services}

TOOLS you can call when needed:
- square_search_availability(startAt, endAt, serviceName)
- square_create_booking(startAt, serviceName, customerGivenName, customerPhone, customerEmail, note)
- square_find_booking(phone, email, name, date)
- square_cancel_booking(bookingId | phone/email/name/date)
- square_reschedule_booking(bookingId | phone/email/name/date, newStartAt)

When reading times back, use the provided 'spoken' field. If not provided, be concise and use the tenant timezone.
`.trim();
}

// ---------- Server ----------
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Health
fastify.get('/', async (_req, reply) => reply.type('text/plain').send('OK'));

// Twilio webhook
const { VoiceResponse } = twilio.twiml;
fastify.post('/incoming-call', async (req, reply) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const toNumber = (req.body?.To || '').trim();
  const tenant = TENANTS[toNumber] || Object.values(TENANTS)[0] || {};

  const vr = new VoiceResponse();
  vr.say(`Thanks for calling ${tenant.studio_name || 'our studio'}. Connecting now.`);
  const connect = vr.connect();
  connect.stream({
    url: `wss://${host}/media-stream`,
    name: 'locsync-stream',
  });
  reply.type('text/xml').send(vr.toString());
});

// Media Streams WS ↔ OpenAI Realtime
fastify.register(async function (app) {
  app.get('/media-stream', { websocket: true }, async (twilioConn, req) => {
    app.log.info('Twilio Media Stream connected');

    // Create OpenAI Realtime WS
    const oa = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' },
    });

    // Load tenant + instructions once OpenAI connects
    oa.on('open', async () => {
      const tenant = Object.values(TENANTS)[0] || {};
      const instructions = await buildInstructions(tenant);

      const sessionUpdate = {
        type: 'session.update',
        session: {
          instructions,
          voice: VOICE,
          modalities: ['text', 'audio'],
          turn_detection: { type: 'server_vad' },
          input_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000, channels: 1 },
          output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000, channels: 1 },
          tools: [
            {
              type: 'function',
              name: 'square_search_availability',
              description: 'Find open appointment slots for a service within a time window',
              parameters: {
                type: 'object',
                properties: {
                  serviceName: { type: 'string' },
                  startAt: { type: 'string' },
                  endAt: { type: 'string' },
                },
                required: ['serviceName', 'startAt', 'endAt'],
              },
            },
            {
              type: 'function',
              name: 'square_create_booking',
              description: 'Create a booking for a customer at a specified time',
              parameters: {
                type: 'object',
                properties: {
                  startAt: { type: 'string' },
                  serviceName: { type: 'string' },
                  customerGivenName: { type: 'string' },
                  customerPhone: { type: 'string' },
                  customerEmail: { type: 'string' },
                  note: { type: 'string' },
                },
                required: ['startAt', 'serviceName'],
              },
            },
            {
              type: 'function',
              name: 'square_find_booking',
              description: 'Find bookings by phone/email/name and optional day',
              parameters: {
                type: 'object',
                properties: {
                  phone: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  date: { type: 'string' },
                },
              },
            },
            {
              type: 'function',
              name: 'square_cancel_booking',
              description: 'Cancel a booking, either by bookingId or by identifiers + optional date',
              parameters: {
                type: 'object',
                properties: {
                  bookingId: { type: 'string' },
                  phone: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  date: { type: 'string' },
                },
              },
            },
            {
              type: 'function',
              name: 'square_reschedule_booking',
              description: 'Reschedule a booking to a new time',
              parameters: {
                type: 'object',
                properties: {
                  bookingId: { type: 'string' },
                  phone: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  date: { type: 'string' },
                  newStartAt: { type: 'string' },
                },
                required: ['newStartAt'],
              },
            },
          ],
        },
      };
      oa.send(JSON.stringify(sessionUpdate));
    });

    // Twilio → OpenAI
    twilioConn.socket.on('message', (buf) => {
      if (oa.readyState === WebSocket.OPEN) {
        // Forward raw Twilio media events to OpenAI Realtime
        oa.send(buf);
      }
    });

    // OpenAI → Twilio + Tool handling
    oa.on('message', async (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch {
        // forward any non-JSON (e.g., audio delta frames) to Twilio
        if (twilioConn.socket.readyState === WebSocket.OPEN) twilioConn.socket.send(buf);
        return;
      }

      // Audio deltas will come through as JSON too; forward to Twilio
      if (twilioConn.socket.readyState === WebSocket.OPEN) {
        // Forward everything (OpenAI expects the Twilio stream to accept them)
        twilioConn.socket.send(Buffer.from(JSON.stringify(msg)));
      }

      // Handle function calls from OpenAI
      if (msg.type === 'response.function_call') {
        const { name, arguments: argStr, call_id } = msg;
        let args = {};
        try { args = typeof argStr === 'string' ? JSON.parse(argStr) : (argStr || {}); } catch {}

        const tenant = Object.values(TENANTS)[0] || {};
        const tz = tenant?.timezone || DEFAULT_TZ;
        const locationId = process.env.SQUARE_DEFAULT_LOCATION_ID || undefined;
        const teamMemberId = process.env.SQUARE_DEFAULT_TEAM_MEMBER_ID || undefined;

        let output = { ok: false, error: 'Unhandled tool' };

        try {
          if (name === 'square_search_availability') {
            const slots = await squareSearchAvailability({
              locationId, teamMemberId,
              serviceName: args.serviceName,
              startAt: args.startAt,
              endAt: args.endAt,
            });
            output = { ok: true, slots };
          }

          if (name === 'square_create_booking') {
            const booking = await squareCreateBooking({
              locationId, teamMemberId,
              startAt: args.startAt,
              serviceName: args.serviceName,
              customerGivenName: args.customerGivenName,
              customerPhone: args.customerPhone,
              customerEmail: args.customerEmail,
              note: args.note,
            });
            output = {
              ok: true,
              booking: {
                id: booking.id,
                startAt: booking.startAt,
                spoken: speakTime(booking.startAt, tz),
                status: booking.status,
              },
            };
          }

          if (name === 'square_find_booking') {
            const list = await squareLookupBookings({
              locationId, teamMemberId,
              phone: args.phone,
              email: args.email,
              name: args.name,
              date: args.date,
              includePast: true,
            });
            const bookings = (list || []).map(b => ({
              id: b.id,
              startAt: b.startAt,
              spoken: speakTime(b.startAt, tz),
              status: b.status,
            }));
            output = { ok: true, bookings };
          }

          if (name === 'square_cancel_booking') {
            let bookingId = args.bookingId;
            if (!bookingId) {
              const list = await squareLookupBookings({
                locationId, teamMemberId,
                phone: args.phone,
                email: args.email,
                name: args.name,
                date: args.date,
                includePast: true,
              });
              bookingId = list?.[0]?.id;
            }
            if (!bookingId) throw new Error('No matching booking to cancel.');
            await squareCancelBooking(bookingId);
            output = { ok: true, booking: { id: bookingId, status: 'CANCELLED' } };
          }

          if (name === 'square_reschedule_booking') {
            let bookingId = args.bookingId;
            if (!bookingId) {
              const list = await squareLookupBookings({
                locationId, teamMemberId,
                phone: args.phone,
                email: args.email,
                name: args.name,
                date: args.date,
                includePast: true,
              });
              bookingId = list?.[0]?.id;
            }
            if (!bookingId) throw new Error('No matching booking to reschedule.');
            const updated = await squareRescheduleBooking(bookingId, args.newStartAt);
            output = {
              ok: true,
              booking: { id: updated.id, startAt: updated.startAt, spoken: speakTime(updated.startAt, tz), status: updated.status },
            };
          }
        } catch (e) {
          output = { ok: false, error: String(e?.message || e) };
        }

        // Send function output back
        oa.send(JSON.stringify({
          type: 'response.function_call_output',
          call_id,
          output: JSON.stringify(output),
        }));
      }
    });

    oa.on('close', () => app.log.info('OpenAI WS closed'));
    oa.on('error', (err) => app.log.error({ err }, 'OpenAI WS error'));

    twilioConn.socket.on('close', () => {
      app.log.info('Twilio WS closed');
      try { oa.close(); } catch {}
    });
  });
});

// Start
try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  fastify.log.info(`Server listening on ${PORT}`);
} catch (e) {
  fastify.log.error(e);
  process.exit(1);
}
