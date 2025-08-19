// server.js
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { twiml as Twiml } from 'twilio';
import { WebSocket as WSClient } from 'ws'; // for OpenAI outbound WS
import crypto from 'node:crypto';

// --- OpenAI Realtime config ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const OPENAI_WS_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;
const OPENAI_VOICE = process.env.OPENAI_VOICE || 'verse';

// --- Square SDK ---
import { Client as SquareClient, Environment as SquareEnv } from 'square';
const square = new SquareClient({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'production' ? SquareEnv.Production : SquareEnv.Sandbox
});

// ---------- Minimal Square helper ----------
async function squareListAppointments({ customerPhone, startAtMin, startAtMax }) {
  // 1) Search customer by phone
  let customerId = null;
  if (customerPhone) {
    const searchBody = {
      query: { filter: { phoneNumber: { exact: customerPhone } } }
    };
    const resp = await square.customersApi.searchCustomers(searchBody);
    const customers = resp.result.customers || [];
    if (!customers.length) {
      return { ok: true, items: [], note: 'No customer found for that phone.' };
    }
    customerId = customers[0].id;
  }

  // 2) List bookings (optionally by time range), then filter by customerId if needed
  const listParams = {};
  if (startAtMin) listParams.startAtMin = startAtMin;
  if (startAtMax) listParams.startAtMax = startAtMax;

  const list = await square.bookingsApi.listBookings(listParams);
  const bookings = (list.result.bookings || []).filter(b => !customerId || b.customerId === customerId);

  const items = bookings.slice(0, 20).map(b => {
    const seg = (b.appointmentSegments || [])[0];
    return {
      id: b.id,
      start_at: b.startAt,
      location_id: b.locationId,
      service: seg?.serviceVariationName,
      team_member_id: seg?.teamMemberId,
      status: b.status
    };
  });
  return { ok: true, items };
}

// ---------- Express: TwiML route ----------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Returns TwiML that starts the bidirectional stream.
// Twilio requires wss:// for <Stream> and no query-string on the URL.
app.post('/incoming-call', (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host; // works on Render
  const wssUrl = `wss://${host}/media-stream`;

  const vr = new Twiml.VoiceResponse();
  const connect = vr.connect();
  connect.stream({ url: wssUrl });

  res.type('text/xml').send(vr.toString());
});

// ---------- HTTP server + WebSocket upgrade ----------
const server = app.listen(process.env.PORT || 10000, () => {
  console.log('HTTP listening on', server.address().port);
});

// One WS endpoint: /media-stream (Twilio connects here)
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media-stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ---------- Twilio <-> OpenAI Realtime bridge ----------
wss.on('connection', async (twilioWS, req) => {
  console.log('Twilio WS connected');
  let streamSid = null;

  // Outbound queue to OpenAI (incoming audio from Twilio)
  // We'll batch-send input_audio_buffer.append and commit periodically.
  const outbox = [];
  let lastAppendTime = 0;
  let committed = true;

  // OpenAI client WS
  const oaiWS = new WSClient(OPENAI_WS_URL, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  oaiWS.on('open', () => {
    // Configure session: voice, server VAD, μ-law in/out, and tools
    oaiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        instructions:
          'You are a friendly, natural-sounding scheduling assistant. ' +
          'Use the tools to check Square appointments. Ask for an E.164 phone number if needed.',
        voice: OPENAI_VOICE,
        modalities: ['text', 'audio'],
        turn_detection: { type: 'server_vad' },
        input_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000, channels: 1 },
        output_audio_format: { type: 'g711_ulaw', sample_rate_hz: 8000, channels: 1 },
        tools: [
          {
            type: 'function',
            name: 'list_square_appointments',
            description: 'List upcoming Square appointments for a client.',
            parameters: {
              type: 'object',
              properties: {
                customerPhone: { type: 'string', description: 'E.164 phone, e.g. +13135551212' },
                startAtMin: { type: 'string' },
                startAtMax: { type: 'string' }
              }
            }
          }
        ]
      }
    }));

    // Optional: have the bot greet first
    oaiWS.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hi! How can I help with appointments today?' }]
      }
    }));
    oaiWS.send(JSON.stringify({ type: 'response.create' }));
  });

  // OpenAI → Twilio: audio deltas & tool calls
  oaiWS.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = msg.type;

    if (t === 'response.audio.delta') {
      const b64 = msg.delta || msg.audio;
      if (b64 && streamSid && twilioWS.readyState === twilioWS.OPEN) {
        // Send audio chunk back to Twilio (G.711 μ-law 8kHz base64)
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: b64 }
        }));
      }
    }

    // Simple function call handler (single tool)
    if (t === 'response.output_item.added' || t === 'response.output_item.done') {
      const item = msg.item || {};
      if (item.type === 'function_call' && item.name === 'list_square_appointments') {
        let args = {};
        try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch {}
        const result = await squareListAppointments({
          customerPhone: args.customerPhone,
          startAtMin: args.startAtMin,
          startAtMax: args.startAtMax
        });

        oaiWS.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: item.id,
            output: JSON.stringify(result)
          }
        }));
        oaiWS.send(JSON.stringify({ type: 'response.create' }));
      }
    }
  });

  oaiWS.on('close', () => console.log('OpenAI WS closed'));
  oaiWS.on('error', (e) => console.error('OpenAI WS error', e));

  // Twilio → OpenAI: incoming audio frames; handle WS events
  const flushTimer = setInterval(() => {
    const now = Date.now();
    if (!committed && now - lastAppendTime > 600) {
      // No new audio for ~600ms: commit and ask model to respond
      oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      oaiWS.send(JSON.stringify({ type: 'response.create' }));
      committed = true;
    }
  }, 200);

  twilioWS.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    const ev = data.event;

    if (ev === 'start') {
      streamSid = data.start?.streamSid;
    } else if (ev === 'media') {
      const b64 = data.media?.payload;
      if (b64) {
        oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }));
        lastAppendTime = Date.now();
        committed = false;
      }
    } else if (ev === 'stop' || ev === 'closed') {
      twilioWS.close();
    }
  });

  twilioWS.on('close', () => {
    clearInterval(flushTimer);
    try {
      oaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      oaiWS.send(JSON.stringify({ type: 'response.create' }));
    } catch {}
    try { oaiWS.close(); } catch {}
    console.log('Twilio WS closed');
  });
});
