import Fastify from 'fastify';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'node:fs/promises';

import {
  listLocations,
  lookupUpcomingBookingsByPhoneOrEmail,
  toE164US
} from './square.js';

// ---------- ENV ----------
dotenv.config();
if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY (set in Render → Environment).');
  process.exit(1);
}

// ---------- FASTIFY ----------
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Health check
fastify.get('/', async (_req, reply) => {
  reply.type('text/plain').send('OK');
});

// Example endpoint: lookup booking
fastify.get('/dev/find', async (req, reply) => {
  try {
    const { phone, email } = req.query || {};
    const res = await lookupUpcomingBookingsByPhoneOrEmail({
      phone: phone ? toE164US(phone) : null,
      email: email ? String(email).trim().toLowerCase() : null
    });

    reply.send({ ok: true, res });
  } catch (e) {
    reply.code(500).send({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 5050;
fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log(`Server running on ${PORT}`))
  .catch(err => {
    fastify.log.error(err);
    process.exit(1);
  });
