// square.js — Square API helpers (ESM)

import dotenv from "dotenv";
dotenv.config();

const { SQUARE_ACCESS_TOKEN } = process.env;
if (!SQUARE_ACCESS_TOKEN) {
  console.error("Missing SQUARE_ACCESS_TOKEN in environment.");
  process.exit(1);
}

const BASE = "https://connect.squareup.com/v2";

// ---------- INTERNAL FETCH WRAPPER ----------
async function sqFetch(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Square API error: ${res.status} ${txt}`);
  }
  return res.json();
}

// ---------- HELPER: Normalize phone ----------
export function toE164US(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.startsWith("+")) return digits;
  return `+1${digits}`;
}

// ---------- LIST LOCATIONS ----------
export async function listLocations() {
  return sqFetch("/locations");
}

// ---------- FIND SERVICE VARIATION BY NAME ----------
export async function findServiceVariationIdByName(serviceName) {
  const catalog = await sqFetch("/catalog/list?types=ITEM");
  for (const obj of catalog.objects || []) {
    if (obj.item_data?.name?.toLowerCase() === serviceName.toLowerCase()) {
      const variations = obj.item_data.variations || [];
      if (variations.length > 0) return variations[0].id;
    }
  }
  return null;
}

// ---------- ENSURE CUSTOMER ----------
export async function ensureCustomerByPhoneOrEmail({
  phone,
  email,
  givenName,
  familyName,
}) {
  // Try search
  let body = { query: { filter: {} } };
  if (phone) {
    body.query.filter.phone_number = { exact: phone };
  } else if (email) {
    body.query.filter.email_address = { exact: email };
  }
  let found = null;
  try {
    const res = await sqFetch("/customers/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res.customers?.length) found = res.customers[0];
  } catch {}

  if (found) return found;

  // Create new
  const payload = {
    given_name: givenName || "Guest",
    family_name: familyName,
    phone_number: phone,
    email_address: email,
  };
  const res = await sqFetch("/customers", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return res.customer;
}

// ---------- RESOLVE CUSTOMER IDS ----------
export async function resolveCustomerIds({ phone, email }) {
  const ids = [];
  const body = { query: { filter: {} } };
  if (phone) {
    body.query.filter.phone_number = { exact: phone };
  } else if (email) {
    body.query.filter.email_address = { exact: email };
  }
  const res = await sqFetch("/customers/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res.customers?.length) {
    res.customers.forEach((c) => ids.push(c.id));
  }
  return ids;
}

// ---------- SEARCH AVAILABILITY ----------
export async function searchAvailability({
  locationId,
  teamMemberId,
  startAt,
  endAt,
  serviceVariationId,
}) {
  const body = {
    query: {
      filter: {
        location_id: locationId,
        segment_filters: [
          {
            service_variation_id: serviceVariationId,
            team_member_id_filter: { any: [teamMemberId] },
          },
        ],
        start_at_range: { start_at: startAt, end_at: endAt },
      },
    },
  };
  return sqFetch("/bookings/availability/search", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---------- CREATE BOOKING ----------
export async function createBooking({
  customerId,
  locationId,
  teamMemberId,
  serviceVariationId,
  startAt,
}) {
  const body = {
    booking: {
      location_id: locationId,
      customer_id: customerId,
      start_at: startAt,
      appointment_segments: [
        {
          duration_minutes: 60,
          service_variation_id: serviceVariationId,
          team_member_id: teamMemberId,
        },
      ],
    },
  };
  return sqFetch("/bookings", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---------- LOOKUP UPCOMING BOOKINGS ----------
export async function lookupUpcomingBookingsByPhoneOrEmail({
  phone,
  email,
  givenName,
  familyName,
  locationId,
  teamMemberId,
  includePast = false,
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
        },
      },
    }),
  });

  let bookings = res.bookings || [];
  if (!includePast) {
    const now = Date.now();
    bookings = bookings.filter(
      (b) => new Date(b.start_at || b.startAt).getTime() >= now
    );
  }

  return { bookings };
}

// ---------- RETRIEVE BOOKING ----------
export async function retrieveBooking(id) {
  return sqFetch(`/bookings/${id}`);
}

// ---------- RESCHEDULE BOOKING ----------
export async function rescheduleBooking(id, newStartAt) {
  const body = {
    booking: {
      start_at: newStartAt,
    },
  };
  return sqFetch(`/bookings/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// ---------- CANCEL BOOKING ----------
export async function cancelBooking(id) {
  return sqFetch(`/bookings/${id}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });
    }
