// index.js (ESM) — Fastify + WebSocket + OpenAI Realtime (works on Render & Twilio)
// Requires: "type": "module" in package.json

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

import { DateTime } from 'luxon';        // add to package.json if missing
import fs from 'node:fs/promises';

// Load tenants.json at startup
let TENANTS = {};
try {
  const raw = await fs.readFile(new URL('./tenants.json', import.meta.url));
  TENANTS = JSON.parse(String(raw));
} catch (e) {
  console.warn('tenants.json not found or invalid; TENANTS={}');
  TENANTS = {};
}

// Simple cache for fetched knowledge text
const kbCache = new Map(); // url -> text

async function fetchKbText(urls = []) {
  let combined = '';
  for (const url of urls) {
    try {
      if (kbCache.has(url)) { combined += '\n\n' + kbCache.get(url); continue; }
      const res = await fetch(url);
      if (!res.ok) continue;
      let txt = await res.text();
      // cap any single file to ~10k chars
      txt = txt.slice(0, 10000);
      kbCache.set(url, txt);
      combined += '\n\n' + txt;
    } catch {}
  }
  return combined.trim();
}

function buildInstructions(tenant, kbText) {
  return `
You are the voice receptionist for "${tenant.studio_name}".
Style: Warm, professional, concise. Let callers interrupt naturally.
Booking: ${tenant.booking_url}
Services: ${tenant.services.join(', ')}.
Pricing notes: ${tenant.pricing_notes.join(' | ')}.
Policies: ${tenant.policies.join(' | ')}.
Use this knowledge when answering FAQs (preferred over generic answers):
${kbText || '(no additional text)'}
Keep answers under 20 seconds. Offer to text the booking link if asked.
Avoid medical advice; refer to a dermatologist when appropriate.`;
}
// Load env
dotenv.config();
const { OPENAI_API_KEY, NODE_ENV } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Set OPENAI_API_KEY in Render → Environment.');
  process.exit(1);
}

// Config
const PORT = process.env.PORT || 5050; // Render injects PORT; 5050 is local fallback
const VOICE = 'alloy';
const SYSTEM_MESSAGE =
  'You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested in and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling—subtly. Always stay positive, but work in a joke when appropriate.';

// Event types you might want to log from OpenAI
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created',
];

// Fastify app (single server)
const fastify = Fastify({ logger: true });

// Plugins
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Health (Render probes this)
fastify.get('/', async (_req, reply) => {
  reply.type('text/plain').send('OK');
});

// Twilio webhook → return TwiML that starts **bidirectional** Media Stream
fastify.all('/incoming-call', async (request, reply) => {
  const host = request.headers['host'];
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Welcome to the Loc Repair Clinic in Southfield, Michigan. We specialize in crochet repair, interlock maintenance, and bald spot coverage. Please hold while our virtual receptionist assists you.</Say>
  <Pause length="1"/>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`.trim();

  reply.type('text/xml').send(twiml);
});

// WebSocket endpoint for Twilio Media Streams
fastify.register(async function (app) {
  app.get('/media-stream', { websocket: true }, (connection /* WebSocket */, req) => {
    app.log.info('Twilio Media Stream connected');

    // Per-connection state
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Connect to OpenAI Realtime API via WebSocket
    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      }
    );

    // Initialize OpenAI session
    const initializeSession = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ['text', 'audio'],
          temperature: 0.8,
        },
      };
      app.log.info({ sessionUpdate }, 'OpenAI session.update');
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    // Send a "mark" to Twilio so we can detect playback boundaries
    const sendMark = () => {
      if (!streamSid) return;
      const markEvent = { event: 'mark', streamSid, mark: { name: 'responsePart' } };
      connection.send(JSON.stringify(markEvent));
      markQueue.push('responsePart');
    };

    // If caller starts speaking, truncate assistant audio and clear Twilio buffer
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsed = latestMediaTimestamp - responseStartTimestampTwilio;

        if (lastAssistantItem) {
          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsed,
          };
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        // Tell Twilio to clear buffered audio
        connection.send(JSON.stringify({ event: 'clear', streamSid }));

        // Reset
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    // --- OpenAI WS handlers ---
    openAiWs.on('open', () => {
      app.log.info('Connected to OpenAI Realtime API');
      setTimeout(initializeSession, 100);
    });

    openAiWs.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (e) {
        app.log.error({ e, raw: buf.toString() }, 'OpenAI message parse error');
        return;
      }

      if (LOG_EVENT_TYPES.includes(msg.type)) {
        app.log.info({ type: msg.type }, 'OpenAI event');
      }

      if (msg.type === 'response.audio.delta' && msg.delta) {
        // Stream audio back to Twilio
        if (streamSid) {
          const audioDelta = {
            event: 'media',
            streamSid,
            media: { payload: msg.delta }, // base64 g711_ulaw
          };
          connection.send(JSON.stringify(audioDelta));

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
          }
          if (msg.item_id) lastAssistantItem = msg.item_id;
          sendMark();
        }
      }

      if (msg.type === 'input_audio_buffer.speech_started') {
        handleSpeechStartedEvent();
      }
    });

    openAiWs.on('close', () => app.log.info('OpenAI WS closed'));
    openAiWs.on('error', (err) => app.log.error({ err }, 'OpenAI WS error'));

    // --- Twilio Media Streams → ingest audio/events ---
    connection.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        app.log.error({ e, raw: raw.toString() }, 'Twilio message parse error');
        return;
      }

      switch (data.event) {
        case 'start':
          streamSid = data.start?.streamSid;
          latestMediaTimestamp = 0;
          responseStartTimestampTwilio = null;
          app.log.info({ streamSid }, 'Media stream started');
          break;

        case 'media':
          latestMediaTimestamp = data.media?.timestamp ?? latestMediaTimestamp;
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(
              JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: data.media?.payload, // base64 g711_ulaw
              })
            );
          }
          break;

        case 'mark':
          if (markQueue.length > 0) markQueue.shift();
          break;

        case 'stop':
          app.log.info('Media stream stopped');
          break;

        default:
          app.log.info({ event: data.event }, 'Twilio event');
      }
    });

    connection.on('close', () => {
      app.log.info('Twilio WS disconnected');
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });
  });
});

// Start server (Render needs 0.0.0.0)
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    fastify.log.info(`Server is listening on port ${PORT} (${NODE_ENV || 'dev'})`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();

const VOICE = 'alloy'; // keep or switch later
const SYSTEM_MESSAGE = `
You are the voice receptionist for "Loc Repair Clinic at U Natural Hair" in Southfield, MI.
Style: Warm, professional, concise. Let callers interrupt naturally.
Hours: Tue–Sat 10am–6pm Eastern.
Services you can describe briefly: Crochet Loc Repair, Interlock Maintenance, Bald Coverage System.
Pricing notes: Interlock maintenance $95 (2–3 turns), $125 (4–6 turns). Consult deposit applies to service if booked within 14 days.
Booking link: https://calendly.com/your-studio/consult
Transfer-to-human: If the caller asks to speak to someone, say you can connect them and follow the transfer instructions.
Policies: 24h reschedule; deposits non-refundable; parking in rear lot (enter Suite 9).
Never give medical advice; if asked, recommend seeing a dermatologist.
Keep answers <20 seconds when possible; offer to text booking link if asked.`;


