// index.js (ESM) — Fastify + Twilio Media Streams + OpenAI Realtime + Square
// package.json must have: "type": "module"

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'node:fs/promises';

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
  cancelBooking,
  toE164US
} from './square.js';

// ---------- ENV ----------
dotenv.config();
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY (set in Render → Environment).');
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
const PORT = process.env.PORT || 10000; // Render injects PORT

// ---------- GLOBAL OVERRIDES ----------
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

// ---------- TENANTS ----------
let TENANTS = {};
try {
  const raw = await fs.readFile(new URL('./tenants.json', import.meta.url));
  TENANTS = JSON.parse(String(raw));
} catch {
  console.warn('⚠️ No tenants.json found; using empty {}');
  TENANTS = {};
}

// ---------- KB HELPERS ----------
const kbCache = new Map();
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
    } catch {}
  }
  return combined.trim();
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

// ---------- FASTIFY ----------
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Health check
fastify.get('/', async (_req, reply) => {
  reply.type('text/plain').send('OK');
});

// --- Twilio Voice Webhook ---
fastify.post('/incoming-call', async (req, reply) => {
  const twiml = `
    <Response>
      <Say voice="alice">Thanks for calling the Loc Repair Clinic. Connecting you now.</Say>
      <Connect>
        <Stream url="wss://${req.hostname}/media-stream" />
      </Connect>
    </Response>
  `;
  reply.type('text/xml').send(twiml.trim());
});

// --- Twilio Media Stream WebSocket (stub) ---
fastify.register(async function (fastify) {
  fastify.get('/media-stream', { websocket: true }, (connection /*, req*/) => {
    console.log('📞 Twilio media stream connected');

    connection.on('message', (msg) => {
      // TODO: hook into OpenAI Realtime + Square logic
      console.log('🔊 Incoming media frame:', msg.toString().slice(0, 100));
    });

    connection.on('close', () => {
      console.log('❌ Twilio media stream disconnected');
    });
  });
});

// ---------- START ----------
fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => {
    console.log(`🚀 Server running on ${PORT}`);
  })
  .catch(err => {
    fastify.log.error(err);
    process.exit(1);
  });
