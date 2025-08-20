// square.js — REST-only (no SDK), Node 20 ESM
// Uses SQUARE_ENV ("production" | "sandbox") and SQUARE_ACCESS_TOKEN

import { randomUUID } from 'node:crypto';

// ---------- Config ----------
const envName = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const BASE_URL =
  envName === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('Missing SQUARE_ACCESS_TOKEN in environment.');
}

// Pick a recent API version (update if Square deprecates later)
const SQUARE_VERSION = '2025-05-15';

// ---------- Core fetch wrapper ----------
async function sqFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) {
    const first = Array.isArray(json?.errors) ? json.errors[0] : null;
    const code = first?.code || '';
    const detail = first?.detail || '';
    const msg = `${res.status} ${res.statusText}${code ? `:${code}` : ''}${detail ? `:${detail}` : ''}`;
    throw new Error(`Square API ${method} ${path} failed: ${msg}`);
  }
  return json;
}

// ---------- Small utils ----------
function onlyDigits(s = '') {
  return String(s || '').replace(/\D+/g, '');
}
function toE164US(phone) {
  const trimmed = (phone || '').trim();
  if (/^\+/.test(trimmed)) return trimmed; // already E.164
  const digits = onlyDigits(trimmed);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed.startsWith('+') ? trimmed : `+${digits}`;
}

// ---------- Locations ----------
export async function listLocations() {
  const { locations = [] } = await sqFetch('/v2/locations', { method: 'GET' });
  return locations;
}

// ---------- Customers ----------
export async function findCustomer({ phone, email, givenName, familyName }) {
  // exact email
  if (email) {
    const body = { query: { filter: { email_address: { exact: String(email).trim() } } } };
    const { customers = [] } = await sqFetch('/v2/customers/search', { method: 'POST', body });
    if (customers[0]) return customers[0];
  }
  // exact phone (E.164)
  if (phone) {
    const e164 = toE164US(phone);
    const body = { query: { filter: { phone_number: { exact: e164 } } } };
    const { customers = [] } = await sqFetch('/v2/customers/search', { method: 'POST', body });
    if (customers[0]) return customers[0];
  }
  // fuzzy by name
  if (givenName || familyName) {
    const filter = {};
    if (givenName)  filter.given_name  = { fuzzy: String(givenName).trim() };
    if (familyName) filter.family_name = { fuzzy: String(familyName).trim() };
    const body = { query: { filter } };
    const { customers = [] } = await sqFetch('/v2/customers/search', { method: 'POST', body });
    if (customers[0]) return customers[0];
  }
  return null;
}

export async function ensureCustomerByPhoneOrEmail({ givenName, phone, email }) {
  const existing = await findCustomer({ phone, email });
  if (existing) return existing;

  const body = {
    given_name: givenName || 'Caller',
    ...(email ? { email_address: String(email).trim() } : {}),
    ...(phone ? { phone_number: toE164US(phone) } : {})
  };
  const { customer } = await sqFetch('/v2/customers', { method: 'POST', body });
  return customer || null;
}

// Convenience for index.js: return an array of IDs (0 or 1)
export async function resolveCustomerIds({ phone, email, givenName, familyName, name }) {
  let gn = givenName, fn = familyName;
  if (name && (!gn && !fn)) {
    // naive split "First Last"
    const parts = String(name).trim().split(/\s+/);
    gn = parts[0];
    fn = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
  }
  const c = await findCustomer({ phone, email, givenName: gn, familyName: fn });
  return c ? [c.id] : [];
}

// ---------- Catalog (services) ----------
export async function findServiceVariationIdByName({ serviceName }) {
  const body = { text_filter: serviceName };
  const { items = [] } = await sqFetch('/v2/catalog/search-catalog-items', { method: 'POST', body });
  for (const item of items) {
    const isSvc = item?.product_type === 'APPOINTMENTS_SERVICE' || item?.productType === 'APPOINTMENTS_SERVICE';
    if (isSvc) {
      const vars = item?.item_data?.variations || item?.itemData?.variations || [];
      if (vars[0]?.id) return vars[0].id;
    }
  }
  return null;
}

async function getServiceVariationVersion(serviceVariationId) {
  const { object } = await sqFetch(
    `/v2/catalog/object/${encodeURIComponent(serviceVariationId)}?include_related_objects=false`,
    { method: 'GET' }
  );
  return object?.version ?? null;
}

// ---------- Availability ----------
export async function searchAvailability({
  locationId,
  teamMemberId,
  serviceVariationId,
  startAt,
  endAt
}) {
  const body = {
    query: {
      filter: {
        location_id: locationId,
        start_at_range: { start_at: startAt, end_at: endAt },
        segment_filters: [
          {
            service_variation_id: serviceVariationId,
            team_member_id_filter: { any: [teamMemberId] }
          }
        ]
      }
    }
  };
  const { availabilities = [] } = await sqFetch('/v2/bookings/availability/search', { method: 'POST', body });
  return availabilities;
}

// ---------- Bookings: create / list / retrieve / cancel / reschedule ----------
export async function createBooking({
  locationId,
  teamMemberId,
  customerId,
  serviceVariationId,
  startAt,
  sellerNote
}) {
  const serviceVariationVersion = await getServiceVariationVersion(serviceVariationId);
  if (serviceVariationVersion == null) {
    throw new Error('Could not resolve service_variation_version for the chosen service.');
  }

  const body = {
    booking: {
      location_id: locationId,
      start_at: startAt,
      customer_id: customerId,
      appointment_segments: [
        {
          service_variation_id: serviceVariationId,
          service_variation_version: serviceVariationVersion,
          team_member_id: teamMemberId
          // duration derived from service variation
        }
      ],
      ...(sellerNote ? { seller_note: sellerNote } : {})
    },
    idempotency_key: randomUUID()
  };

  const { booking } = await sqFetch('/v2/bookings', { method: 'POST', body });
  return booking || null;
}

// GET /v2/bookings with filters
export async function listBookings({
  customerId,
  locationId,
  teamMemberId,
  startAtMin,  // ISO
  startAtMax,  // ISO
  limit = 50,
  cursor
}) {
  const qs = new URLSearchParams();
  if (customerId)   qs.set('customer_id', customerId);
  if (locationId)   qs.set('location_id', locationId);
  if (teamMemberId) qs.set('team_member_id', teamMemberId);
  if (startAtMin)   qs.set('start_at_min', startAtMin);
  if (startAtMax)   qs.set('start_at_max', startAtMax);
  if (limit)        qs.set('limit', String(limit));
  if (cursor)       qs.set('cursor', cursor);

  const path = `/v2/bookings?${qs.toString()}`;
  const { bookings = [], cursor: nextCursor } = await sqFetch(path, { method: 'GET' });
  return { bookings, cursor: nextCursor };
}

// Support your index.js: search by one or more customerIds (merge results)
export async function searchBookingsByCustomer({
  customerIds = [],
  locationId,
  teamMemberId,
  startAt, // ISO start
  endAt    // ISO end
}) {
  const out = [];
  for (const cid of customerIds) {
    let cursor;
    do {
      const { bookings, cursor: next } = await listBookings({
        customerId: cid,
        locationId,
        teamMemberId,
        startAtMin: startAt,
        startAtMax: endAt,
        limit: 50,
        cursor
      });
      out.push(...(bookings || []));
      cursor = next;
    } while (cursor);
  }
  return out;
}

// Accept either a string id or { bookingId }
export async function retrieveBooking(param) {
  const bookingId = typeof param === 'string' ? param : param?.bookingId;
  if (!bookingId) throw new Error('retrieveBooking: bookingId is required');
  const { booking } = await sqFetch(`/v2/bookings/${encodeURIComponent(bookingId)}`, { method: 'GET' });
  return booking || null;
}

export async function cancelBooking({ bookingId, version }) {
  if (!bookingId) throw new Error('cancelBooking: bookingId is required');
  if (version == null) {
    const current = await retrieveBooking(bookingId);
    if (!current) throw new Error('cancelBooking: booking not found');
    version = current.version;
  }
  const body = { version };
  const { booking } = await sqFetch(`/v2/bookings/${encodeURIComponent(bookingId)}/cancel`, { method: 'POST', body });
  return booking || null;
}

export async function rescheduleBooking({ bookingId, newStartAt }) {
  if (!bookingId) throw new Error('rescheduleBooking: bookingId is required');
  if (!newStartAt) throw new Error('rescheduleBooking: newStartAt (ISO) is required');

  const current = await retrieveBooking(bookingId);
  if (!current) throw new Error(`Booking not found: ${bookingId}`);

  // Build the minimal update payload (snake_case)
  const booking = {
    id: current.id,
    version: current.version,
    location_id: current.location_id || current.locationId,
    customer_id: current.customer_id || current.customerId,
    start_at: newStartAt,
    appointment_segments: (current.appointment_segments || current.appointmentSegments || []).map(seg => ({
      service_variation_id: seg.service_variation_id || seg.serviceVariationId,
      service_variation_version: seg.service_variation_version || seg.serviceVariationVersion,
      team_member_id: seg.team_member_id || seg.teamMemberId
    }))
  };

  const body = { idempotency_key: randomUUID(), booking };
  const { booking: updated } = await sqFetch(
    `/v2/bookings/${encodeURIComponent(bookingId)}`,
    { method: 'PUT', body }
  );
  return updated || null;
}

// (Optional) helper you might still use elsewhere
export async function lookupUpcomingBookingsByPhoneOrEmail({
  phone,
  email,
  givenName,
  familyName,
  locationId,
  teamMemberId,
  includePast = false
}) {
  const customer = await findCustomer({ phone, email, givenName, familyName });
  if (!customer) return { customer: null, bookings: [] };

  const nowIso = new Date().toISOString();
  const { bookings } = await listBookings({
    customerId: customer.id,
    locationId,
    teamMemberId,
    startAtMin: includePast ? undefined : nowIso,
    limit: 50
  });

  return { customer, bookings };
  }
