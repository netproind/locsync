// index.js — Fastify + Twilio Media Streams + OpenAI Realtime + Square
// package.json must have: "type": "module"

import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fs from "node:fs/promises";
import twilio from "twilio"; // ✅ for TwiML

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
  toE164US, // ✅ expose helper from square.js
} from "./square.js";

// ---------- ENV ----------
dotenv.config();
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY (set in Render → Environment).");
  process.exit(1);
}

// ---------- DEFAULTS ----------
const DEFAULTS = {
  voice: "alloy",
  model: "gpt-4o-realtime-preview-2024-10-01",
  temperature: 0.7,
  modalities: ["text", "audio"],
  turn_detection: { type: "server_vad" },
  kb_per_file_char_cap: 10000,
  instructions_char_cap: 24000,
  greeting_tts: null,
};

// ---------- PORT ----------
const PORT = process.env.PORT || 5050;

// ---------- GLOBAL OVERRIDES ----------
let OVERRIDES = [];
try {
  const rawOv = await fs.readFile(new URL("./overrides.json", import.meta.url));
  OVERRIDES = JSON.parse(String(rawOv));
} catch {
  OVERRIDES = [];
}
OVERRIDES = Array.isArray(OVERRIDES)
  ? OVERRIDES.filter(
      (o) => o && typeof o.match === "string" && typeof o.reply === "string"
    )
  : [];

// ---------- TENANTS ----------
let TENANTS = {};
try {
  const raw = await fs.readFile(new URL("./tenants.json", import.meta.url));
  TENANTS = JSON.parse(String(raw));
} catch {
  console.warn("No tenants.json found; using empty {}");
  TENANTS = {};
}

// ---------- KB HELPERS ----------
const kbCache = new Map();
let currentKbCap = DEFAULTS.kb_per_file_char_cap;

async function fetchKbText(urls = []) {
  let combined = "";
  for (const url of urls) {
    try {
      if (kbCache.has(url)) {
        combined += "\n\n" + kbCache.get(url);
        continue;
      }
      const res = await fetch(url);
      if (!res.ok) continue;
      let txt = await res.text();
      const cap = currentKbCap || DEFAULTS.kb_per_file_char_cap;
      txt = txt.slice(0, cap);
      kbCache.set(url, txt);
      combined += "\n\n" + txt;
    } catch {}
  }
  return combined.trim();
}

function sqDefaults() {
  return {
    locationId: process.env.SQUARE_DEFAULT_LOCATION_ID,
    teamMemberId: process.env.SQUARE_DEFAULT_TEAM_MEMBER_ID,
  };
}

// ---------- DATE/TIME HELPERS ----------
function dayWindowUTC(isoDate) {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  const startAt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0)).toISOString();
  const endAt = new Date(Date.UTC(y, m - 1, d, 23, 59, 59)).toISOString();
  return { startAt, endAt };
}

function speakTime(iso, tz = "America/Detroit") {
  if (!iso) return "";
  const dt = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(dt);
}

// ---------- INSTRUCTIONS BUILDER ----------
function buildInstructions(tenant, kbText = "") {
  const style = tenant?.voice_style || "warm, professional, concise";
  const services = Array.isArray(tenant?.services) ? tenant.services : [];
  const pricing = Array.isArray(tenant?.pricing_notes)
    ? tenant.pricing_notes
    : [];
  const policies = Array.isArray(tenant?.policies) ? tenant.policies : [];
  const studio = tenant?.studio_name || "our studio";
  const booking = tenant?.booking_url || "(unset)";

  const canonical =
    (tenant?.canonical_answers || [])
      .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`)
      .join("\n") || "(none)";

  return `You are the voice receptionist for "${studio}".
Tone & style: ${style}. Keep answers under 20 seconds.

BOOKING
- Booking link: ${booking}
- To check slots: use square_search_availability, then square_create_booking.

APPOINTMENT LOOKUP
- Ask for phone/email (normalize to E.164).
- Call square_find_booking, read back 'spoken' times.
- If none found, politely say so.

CANCEL / RESCHEDULE
- Confirm intent, then call square_cancel_booking or square_reschedule_booking.

SERVICES
- ${services.join(", ")}

PRICING NOTES
- ${pricing.join(" | ")}

POLICIES
- ${policies.join(" | ")}

CANONICAL Q&A:
${canonical}

TENANT FAQ TEXT:
${kbText || "(none)"}`;
}

// ---------- FASTIFY ----------
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Health check
fastify.get("/", async (_req, reply) => {
  reply.type("text/plain").send("OK");
});

// --- DEV: find bookings by phone/email ---
fastify.get("/dev/find", async (req, reply) => {
  try {
    const { phone, email, name, date } = req.query || {};
    const { locationId, teamMemberId } = sqDefaults();

    let givenName, familyName;
    if (name) {
      const parts = String(name).trim().split(/\s+/);
      givenName = parts[0];
      familyName = parts.slice(1).join(" ") || undefined;
    }

    let startAt, endAt;
    if (date) ({ startAt, endAt } = dayWindowUTC(date));

    const res = await lookupUpcomingBookingsByPhoneOrEmail({
      phone: phone ? toE164US(phone) : null,
      email: email ? String(email).trim().toLowerCase() : null,
      givenName,
      familyName,
      locationId,
      teamMemberId,
      includePast: true,
    });

    let list = res.bookings || [];
    if (startAt || endAt) {
      const s = startAt ? new Date(startAt).getTime() : -Infinity;
      const e = endAt ? new Date(endAt).getTime() : Infinity;
      list = list.filter((b) => {
        const t = new Date(b.start_at || b.startAt).getTime();
        return t >= s && t <= e;
      });
    }

    const tz = Object.values(TENANTS)[0]?.timezone || "America/Detroit";
    const items = list.map((b) => ({
      id: b.id,
      startAt: b.start_at || b.startAt,
      spoken: speakTime(b.start_at || b.startAt, tz),
      status: b.status || "BOOKED",
    }));

    reply.send({ ok: true, count: items.length, items });
  } catch (e) {
    reply.code(500).send({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Twilio incoming call route ----------
fastify.post("/incoming-call", async (req, reply) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Thanks for calling, connecting you now.");
  twiml.connect().stream({
    url: `wss://${req.headers.host}/ws`, // ✅ your WebSocket endpoint
  });
  reply.type("text/xml").send(twiml.toString());
});

// ---------- START ----------
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Server is listening on ${address}`);
});
