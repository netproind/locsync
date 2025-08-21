// index.js — baseline + Twilio + OpenAI Realtime skeleton
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import Twilio from 'twilio';

import {
  lookupUpcomingBookingsByPhoneOrEmail,
  toE164US
} from './square.js';

dotenv.config();

const { OPENAI_API_KEY, PORT, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ---------- Health ----------
fastify.get('/', async (_req, reply) => {
  reply.type('text/plain').send('OK');
});

// ---------- DEV: find bookings ----------
fastify.get('/dev/find', async (req, reply) => {
  try {
    const { phone, email } = req.query || {};
    const res = await lookupUpcomingBookingsByPhoneOrEmail({
      phone: phone ? toE164US(phone) : null,
      email: email || null,
      includePast: true
    });
    reply.send({ ok: true, bookings: res.bookings || [] });
  } catch (e) {
    reply.code(500).send({ ok: false, error: String(e) });
  }
});

// ---------- Twilio Voice webhook ----------
fastify.post('/voice', async (req, reply) => {
  const twiml = new Twilio.twiml.VoiceResponse();
  // Play greeting
  twiml.say("Thanks for calling. Connecting you now.");
  // Connect to our WS endpoint
  twiml.connect({
    action: '/voice/done', // optional callback when disconnects
  }).stream({
    url: `wss://${req.headers.host}/ws`
  });
  reply.type('text/xml').send(twiml.toString());
});

// Optional: handle disconnect
fastify.post('/voice/done', async (_req, reply) => {
  reply.type('text/plain').send('Call ended.');
});

// ---------- WebSocket bridge ----------
fastify.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (connection /*, req*/) => {
    fastify.log.info("🔌 Twilio media stream connected");

    // Incoming from Twilio → log only (later we send to OpenAI)
    connection.socket.on('message', (msg) => {
      fastify.log.info(`Twilio WS msg: ${msg.toString().slice(0, 100)}`);
    });

    // Outgoing to Twilio (placeholder)
    connection.socket.send(JSON.stringify({ event: 'connected' }));

    connection.socket.on('close', () => {
      fastify.log.info("❌ Twilio WS disconnected");
    });
  });
});

// ---------- Tool handler stub ----------
async function handleToolCall(name, args) {
  if (name === 'square_find_booking') {
    const res = await lookupUpcomingBookingsByPhoneOrEmail({
      phone: args.phone ? toE164US(args.phone) : null,
      email: args.email || null,
      includePast: true
    });
    return { ok: true, bookings: res.bookings || [] };
  }
  return { ok: false, error: `Unknown tool ${name}` };
}

// ---------- Start ----------
const port = PORT || 5050;
fastify.listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`🚀 Server running on ${port}`))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
