// index.js (ESM) — Fastify + WebSocket + OpenAI Realtime bridge
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Load env
dotenv.config();
const { OPENAI_API_KEY, NODE_ENV } = process.env;
if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Set OPENAI_API_KEY in the environment.');
  process.exit(1);
}

// Constants
const SYSTEM_MESSAGE =
  'You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested in and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling—subtly. Always stay positive, but work in a joke when appropriate.';
const VOICE = 'alloy';
const PORT = process.env.PORT || 5050; // Render provides PORT; fallback for local

// Fastify app
const fastify = Fastify({ logger: true });
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWs);

// Health check (Render probes /)
fastify.get('/', async (_req, reply) => {
  reply.type('text/plain').send('OK');
});

// Twilio incoming call → return TwiML that starts a bidirectional Media Stream
fastify.all('/incoming-call', async (request, reply) => {
  // Use the host Twilio reached (Render gives correct public host in Host header)
  const host = request.headers['host'];
  // IMPORTANT: use wss:// for Twilio Media Streams
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to the A.I. voice assistant, powered by Twilio and the Open A I Realtime A P I.</Say>
  <Pause length="1"/>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  reply.type('text/xml').send(twiml);
});

// WebSocket endpoint that Twilio Media Streams will connect to
fastify.register(async function (app) {
  app.get('/media-stream', { websocket: true }, (connection, req) => {
    app.log.info('Twilio Media Stream connected');

    // Per-connection state
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Connect to OpenAI Realtime API (WebSocket)
    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      }
    );

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

    const sendMark = () => {
      if (!streamSid) return;
      const markEvent = {
        event: 'mark',
        streamSid,
        mark: { name: 'responsePart' },
      };
      connection.send(JSON.stringify(markEvent));
      markQueue.push('responsePart');
    };

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
        connection.send(
          JSON.stringify({
            event: 'clear',
            streamSid,
          })
        );

        // Reset
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    // OpenAI WS handlers
    openAiWs.on('open', () => {
      app.log.info('Connected to OpenAI Realtime API');
      setTimeout(initializeSession, 100);
    });

    openAiWs.on('message', (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (e) {
        app
