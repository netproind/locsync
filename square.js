// square.js — Square API helpers
// package.json must have: "type": "module"

import fetch from "node-fetch";

// ---------- CONFIG ----------
const SQUARE_API_BASE = "https://connect.squareup.com/v2";
const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
if (!SQUARE_TOKEN) {
  console.error("❌ Missing SQUARE_ACCESS_TOKEN (set in Render → Environment).");
  process.exit(1);
}

// ---------- INTERNAL FETCH WRAPPER ----------
async function sqFetch(path, opts = {}) {
  const res = await fetch(`${SQUARE_API_BASE}${path}`, {
    ...opts,
    headers: {
      "Square-Version": "2025-02-20",
      "Authorization": `Bearer ${SQUARE_TOKEN}`,
      "Content-Type": "application/json",
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Square API ${path} failed ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------- PHONE NORMALIZER ----------
export function toE164US(input) {
  if (!input) return null;
  let digits = String(input).replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.startsWith("+")) return digits;
  return `+1${digits}`;
}

// ---------- CUSTOMER HELPERS ----------
export async function ensureCustomerByPhoneOrEmail({ phone, email, givenName, familyName }) {
  let query = [];
  if (phone) query.push({ phone_number: toE164US(phone) });
  if (email) query.push({ email_address: email });

  let found = [];
  if (query.length) {
    const res = await sqFetch("/customers/search", {
      method: "POST",
      body: JSON.stringify({ query: { filter: { ...query[0] } } })
    });
    found = res.customers || [];
  }

  if (found.length) return found[0];

  // Create if none found
  const res = await sqFetch("/customers", {
    method: "POST",
    body: JSON.stringify({
      given_name: givenName,
      family_name: familyName,
      phone_number: phone ? toE164US(phone) : undefined,
      email_address: email || undefined
    })
  });
  return res.customer;
}

export async function resolveCustomerIds({ phone, email }) {
  const e164 = phone ? toE164US(phone) : null;
  let found = [];
  if (e164) {
    const res = await sqFetch("/customers/search", {
      method: "POST",
      body: JSON.stringify({
        query: { filter: { phone_number: { exact: e164 } } }
      })
    });
    found = res.customers || [];
  }
  if (!found.length && email) {
    const res = await sqFetch("/customers/search", {
      method: "POST",
      body: JSON.stringify({
        query: { filter: { email_address: { exact: email } } }
      })
    });
    found = res.customers || [];
  }
  return found.map(c => c.id);
}

// ---------- LOCATIONS ----------
export async function listLocations() {
  const res = await sqFetch("/locations");
  return res.locations || [];
}

// ---------- SERVICES ----------
export async function findServiceVariationIdByName(catalogObjectName) {
  const res = await sqFetch("/catalog/search", {
    method: "POST",
    body: JSON.stringify({
      object_types: ["ITEM"],
      query: {
        text_query: { keywords: [catalogObjectName] }
      }
    })
  });
  const items = res.objects || [];
  for (const item of items) {
    for (const variation of item.item_data?.variations || []) {
      return variation.id;
    }
  }
  return null;
}

// ---------- AVAILABILITY ----------
export async function searchAvailability({ locationId, teamMemberId, startAt, endAt, serviceVariationId }) {
  const res = await sqFetch("/bookings/availability/search", {
    method: "POST",
    body: JSON.stringify({
      query: {
        filter: {
          location_id: locationId,
          segment_filters: [
            {
              service_variation_id: serviceVariationId,
              team_member_id_filter: { any: [teamMemberId] }
            }
          ],
          start_at_range: { start_at: startAt, end_at: endAt }
        }
      }
    })
  });
  return res.availabilities || [];
}

// ---------- BOOKINGS ----------
export async function createBooking({ locationId, teamMemberId, customerId, serviceVariationId, startAt }) {
  const res = await sqFetch("/bookings", {
    method: "POST",
    body: JSON.stringify({
      booking: {
        location_id: locationId,
        customer_id: customerId,
        start_at: startAt,
        appointment_segments: [
          {
            duration_minutes: 60,
            service_variation_id: serviceVariationId,
            team_member_id: teamMemberId
          }
        ]
      }
    })
  });
  return res.booking;
}

export async function retrieveBooking(id) {
  const res = await sqFetch(`/bookings/${id}`);
  return res.booking;
}

export async function cancelBooking(id) {
  const res = await sqFetch(`/bookings/${id}/cancel`, { method: "POST" });
  return res.booking;
}

export async function rescheduleBooking({ id, startAt }) {
  const res = await sqFetch(`/bookings/${id}`, {
    method: "PUT",
    body: JSON.stringify({
      booking: { start_at: startAt }
    })
  });
  return res.booking;
}

// Lookup bookings by phone/email (recent + upcoming)
export async function lookupUpcomingBookingsByPhoneOrEmail({
  phone,
  email,
  givenName,
  familyName,
  locationId,
  teamMemberId,
  includePast = false
}) {
  const customerIds = await resolveCustomerIds({ phone, email });
  if (!customerIds.length) return { bookings: [] };

  const res = await sqFetch("/bookings/search", {
    method: "POST",
    body: JSON.stringify({
      query: {
        filter: {
          customer_ids: customerIds,
          location_id: locationId,
          team_member_id_filter: teamMemberId ? { any: [teamMemberId] } : undefined
        }
      }
    })
  });
  let bookings = res.bookings || [];

  if (!includePast) {
    const now = Date.now();
    bookings = bookings.filter(b => new Date(b.start_at).getTime() >= now);
  }

  return { bookings };
}
