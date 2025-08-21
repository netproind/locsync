// index.js — Twilio Media Streams + OpenAI Realtime + Square + Tenants + Knowledge
import Fastify from 'fastify';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'node:fs/promises';
import twilio from 'twilio';
import WebSocket from 'ws';

import {
  searchAvailability,
  createBooking,
  ensureCustomerByPhoneOrEmail,
  lookupUpcomingBookingsByPhoneOrEmail,
  rescheduleBooking,
  cancelBooking,
  toE164US
} from './square.js';

dotenv.config();

// ---------- ENV ----------
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY (set in Render → Environment).');
  process.exit(1);
}
const PORT = process.env.PORT || 5050;

// ---------- TENANTS ----------
let TENANTS = {};
try {
  const raw = await fs.readFile(new URL('./tenants.json', import.meta.url));
  TENANTS = JSON.parse(String(raw));
} catch {
  TENANTS = {};
}

// ---------- KNOWLEDGE DOC ----------
async function loadKnowledge() {
  try {
    const raw = await fs.readFile(new URL('./knowledge.md', import.meta.url));
    return String(raw).slice(0, 20000);
  } catch {
    return '';
  }
}

// ---------- TIME HELPERS ----------
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

// ---------- INSTRUCTIONS BUILDER ----------
async function buildInstructions(tenant) {
  const kb = await loadKnowledge();
  const style = tenant?.voice_style || 'warm, professional, concise';
  const studio = tenant?.studio_name || 'our studio';
  const booking = tenant?.booking_url || '(no booking url)';

  return `
You are the AI receptionist for "${studio}".
Tone & style: ${style}.
Keep answers under 20 seconds.

BOOKING:
- If asked to check availability, call tool square_search_availability.
- If asked to book, call tool square_create_booking.
- If asked to cancel or reschedule, call the corresponding tool.

APPOINTMENT LOOKUP:
- Ask for phone/email. Normalize phone to E.164.
- Use tool square_find_booking to retrieve.

KNOWLEDGE BASE:
${kb || '(no extra knowledge provided)'}
`.trim();
}

// ---------- FASTIFY ----------
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Health check
fastify.get('/', async (_req, reply) => {
  reply.type('text/plain').send('OK');
});

// ---------- Twilio inbound webhook ----------
const { VoiceResponse } = twilio.twiml;

fastify.post('/incoming-call', async (req, reply) => {
  const { To } = req.body || {};
  const tenant = TENANTS[To] || {};

  const vr = new VoiceResponse();
  vr.say(`Hi, this is ${tenant.studio_name || "our studio"}. Connecting you now.`);

  vr.connect().stream({
    url: `wss://${req.hostname}/media-stream`,
    name: "locsync-stream"
  });

  reply.type('text/xml').send(vr.toString());
});

// ---------- Media Stream WS bridge ----------
fastify.register(async function (fastify) {
  fastify.get('/media-stream', { websocket: true }, async (conn, req) => {
    fastify.log.info("New media stream connection from Twilio");

    const tenant = Object.values(TENANTS)[0] || {};
    const instructions = await buildInstructions(tenant);

    // OpenAI realtime connection
    const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01", {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    oaWs.on('open', () => {
      const sessionConfig = {
        type: "session.update",
        session: {
          instructions,
          voice: tenant.voice || "alloy",
          modalities: ["text", "audio"],
          tools: [
            { name: "square_find_booking", description: "Lookup bookings by phone/email" },
            { name: "square_create_booking", description: "Create new booking" },
            { name: "square_cancel_booking", description: "Cancel a booking" },
            { name: "square_reschedule_booking", description: "Reschedule a booking" }
          ]
        }
      };
      oaWs.send(JSON.stringify(sessionConfig));
    });

    // Relay Twilio → OpenAI
    conn.socket.on('message', (msg) => {
      if (oaWs.readyState === WebSocket.OPEN) oaWs.send(msg);
    });

    // Handle tool calls + forward messages
    oaWs.on('message', async (msg) => {
      let data;
      try { data = JSON.parse(msg.toString()); } catch {}

      // Handle Square tools
      if (data?.type === 'tool_call') {
        let result = {};

        try {
          if (data.name === 'square_find_booking') {
            const { phone, email } = data.arguments;
            const res = await lookupUpcomingBookingsByPhoneOrEmail({
              phone: phone ? toE164US(phone) : null,
              email: email ? email.trim().toLowerCase() : null,
              includePast: true
            });
            result = {
              bookings: (res.bookings || []).map(b => ({
                id: b.id,
                spoken: speakTime(b.start_at || b.startAt, tenant.timezone || 'America/Detroit'),
                status: b.status
              }))
            };
          }

          if (data.name === 'square_create_booking') {
            const { phone, email, service, datetime } = data.arguments;
            const customer = await ensureCustomerByPhoneOrEmail({ phone: toE164US(phone), email });
            const booking = await createBooking({ customer, service, datetime });
            result = { success: true, bookingId: booking.id, spoken: speakTime(booking.start_at, tenant.timezone) };
          }

          if (data.name === 'square_cancel_booking') {
            const { bookingId } = data.arguments;
            await cancelBooking(bookingId);
            result = { success: true, bookingId };
          }

          if (data.name === 'square_reschedule_booking') {
            const { bookingId, newDateTime } = data.arguments;
            const booking = await rescheduleBooking(bookingId, newDateTime);
            result = { success: true, bookingId, spoken: speakTime(booking.start_at, tenant.timezone) };
          }

        } catch (e) {
          result = { error: String(e?.message || e) };
        }

        // Send back to model
        oaWs.send(JSON.stringify({
          type: "tool_result",
          tool_call_id: data.id,
          result
        }));
        return;
      }

      // Relay everything else back to Twilio
      if (conn.socket.readyState === WebSocket.OPEN) {
        conn.socket.send(msg);
      }
    });

    conn.socket.on('close', () => oaWs.close());
  });
});

// ---------- Server start ----------
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, addr) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Server is listening on ${addr}`);
});
