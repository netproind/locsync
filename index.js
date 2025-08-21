// index.js — Fastify + Twilio Media Streams + OpenAI Realtime + Square
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'node:fs/promises';

import {
  ensureCustomerByPhoneOrEmail,
  resolveCustomerIds,
  lookupUpcomingBookingsByPhoneOrEmail,
  toE164US
} from './square.js';

dotenv.config();
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY.');
  process.exit(1);
}

const PORT = process.env.PORT || 5050;
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ---------- TENANTS ----------
let TENANTS = {};
try {
  const raw = await fs.readFile(new URL('./tenants.json', import.meta.url));
  TENANTS = JSON.parse(String(raw));
} catch {
  TENANTS = {};
}

// ---------- DATE/TIME ----------
function speakTime(iso, tz = 'America/Detroit') {
  if (!iso) return '';
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

// ---------- Health check ----------
fastify.get('/', async (_req, reply) => {
  reply.type('text/plain').send('OK');
});

// ---------- Dev lookup ----------
fastify.get('/dev/find', async (req, reply) => {
  try {
    const { phone, email, name } = req.query || {};
    const { locationId, teamMemberId } = {
      locationId: process.env.SQUARE_DEFAULT_LOCATION_ID,
      teamMemberId: process.env.SQUARE_DEFAULT_TEAM_MEMBER_ID
    };

    let givenName, familyName;
    if (name) {
      const parts = String(name).trim().split(/\s+/);
      givenName = parts[0];
      familyName = parts.slice(1).join(' ') || undefined;
    }

    const res = await lookupUpcomingBookingsByPhoneOrEmail({
      phone: phone ? toE164US(phone) : null,
      email: email ? String(email).trim().toLowerCase() : null,
      givenName,
      familyName,
      locationId,
      teamMemberId,
      includePast: true
    });

    const tz = (Object.values(TENANTS)[0]?.timezone) || 'America/Detroit';
    const items = (res.bookings || []).map(b => ({
      id: b.id,
      startAt: b.start_at || b.startAt,
      spoken: speakTime(b.start_at || b.startAt, tz),
      status: b.status || 'BOOKED'
    }));

    reply.send({ ok: true, count: items.length, items });
  } catch (e) {
    reply.code(500).send({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Twilio <-> OpenAI Realtime bridge ----------
// KEEP your Twilio/OpenAI WS bridge logic here, just update the booking tool handler:

async function handleSquareFindBooking(args, tenantRef) {
  const tz = tenantRef?.timezone || 'America/Detroit';

  const phone = args.phone ? toE164US(args.phone) : null;
  const email = args.email ? String(args.email).trim().toLowerCase() : null;

  let givenName, familyName;
  if (args.name) {
    const parts = String(args.name).trim().split(/\s+/);
    givenName = parts[0];
    familyName = parts.slice(1).join(' ') || undefined;
  }

  const { locationId, teamMemberId } = {
    locationId: process.env.SQUARE_DEFAULT_LOCATION_ID,
    teamMemberId: process.env.SQUARE_DEFAULT_TEAM_MEMBER_ID
  };

  const res = await lookupUpcomingBookingsByPhoneOrEmail({
    phone,
    email,
    givenName,
    familyName,
    locationId,
    teamMemberId,
    includePast: true
  });

  const list = res.bookings || [];
  if (!list.length) {
    return { ok: true, bookings: [], note: "No appointments found in the last 31 days." };
  } else {
    const formatted = list.map(b => ({
      bookingId: b.id,
      startAt: b.start_at || b.startAt,
      spoken: speakTime(b.start_at || b.startAt, tz),
      status: b.status || 'BOOKED'
    }));
    return { ok: true, bookings: formatted };
  }
}

fastify.listen({ port: PORT, host: '0.0.0.0' });
