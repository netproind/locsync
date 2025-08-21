// square.js — REST-only implementation (no SDK), Node 20 ESM
// Works with either sandbox or production via SQUARE_ENV + SQUARE_ACCESS_TOKEN.

import { randomUUID } from 'node:crypto';

const envName = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const BASE_URL =
  envName === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('Missing SQUARE_ACCESS_TOKEN in environment.');
}

// Pick a recent, valid Square-Version (update later if Square deprecates)
const SQUARE_VERSION = '2025-05-15';

// ------------------------ core fetch wrapper ------------------------
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

// ------------------------ small utils ------------------------
function onlyDigits(s = '') {
  return String(s || '').replace(/\D+/g, '');
}
function toE164US(phone) {
  const trimmed = (phone || '').trim();
  if (/^\+/.test(trimmed)) return trimmed;        // already E.164
  const digits = onlyDigits(trimmed);
  if (digits.length === 10) return `+1${digits}`;  // assume US numbers
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed.startsWith('+') ? trimmed : `+${digits}`;
}

// ------------------------ Locations ------------------------
export async function listLocations() {
  const { locations = [] } = await sqFetch('/v2/locations', { method: 'GET' });
  return locations;
}

// ------------------------ Customers (robust) ------------------------

// Internal: paginate SearchCustomers (handles >100 results)
async function searchCustomersAll({ email, phone, text }) {
  const out = [];

  // Strategy 1 — exact email
  if (email) {
    let cursor;
    do {
      const body = {
        limit: 100,
        cursor,
        query: { filter: { email_address: { exact: String(email).trim() } } }
      };
      const res = await sqFetch('/v2/customers/search', { method: 'POST', body });
      out.push(...(res.customers || []));
      cursor = res.cursor || null;
    } while (cursor);
    if (out.length) return out;
  }

  // Strategy 2 — exact phone (E.164)
  if (phone) {
    let cursor;
    const e164 = toE164US(phone);
    do {
      const body = {
        limit: 100,
        cursor,
        query: { filter: { phone_number: { exact: e164 } } }
      };
      const res = await sqFetch('/v2/customers/search', { method: 'POST', body });
      out.push(...(res.customers || []));
      cursor = res.cursor || null;
    } while (cursor);
    if (out.length) return out;
  }

  // Strategy 3 — text_filter for name/company/email/phone prefix matching
  if (text) {
    let cursor;
    do {
      const body = {
        limit: 100,
        cursor,
        query: { text_filter: String(text).trim() }
      };
      const res = await sqFetch('/v2/customers/search', { method: 'POST', body });
      out.push(...(res.customers || []));
      cursor = res.cursor || null;
    } while (cursor);
  }

  return out;
}

// Return the single best match if possible; otherwise first match.
// Accepts any combo of {phone, email, givenName, familyName}.
export async function findCustomer({ phone, email, givenName, familyName }) {
  const text =
    (givenName && familyName) ? `${givenName} ${familyName}` :
    (givenName || familyName) ? (givenName || familyName)  :
    null;

  const customers = await searchCustomersAll({ email, phone, text });
  if (!customers.length) return null;

  // Prefer exact email
  if (email) {
    const exactEmail = customers.find(
      c => c.email_address && c.email_address.toLowerCase() === String(email).trim().toLowerCase()
    );
    if (exactEmail) return exactEmail;
  }
  // Prefer exact phone
  if (phone) {
    const e164 = toE164US(phone);
    const exactPhone = customers.find(c => c.phone_number && c.phone_number === e164);
    if (exactPhone) return exactPhone;
  }

  // Fall back to most recently updated
  customers.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  return customers[0];
}

export async function ensureCustomerByPhoneOrEmail({ givenName, phone, email }) {
  const existing = await findCustomer({ phone, email, givenName });
  if (existing) return existing;

  const body = {
    given_name: givenName || 'Caller',
    ...(email ? { email_address: String(email).trim() } : {}),
    ...(phone ? { phone_number: toE164US(phone) } : {})
  };
  const { customer } = await sqFetch('/v2/customers', { method: 'POST', body });
  return customer || null;
}

// Keep index.js happy if it expects an array of IDs.
export async function resolveCustomerIds({ phone, email, givenName, familyName }) {
  try {
    const c = await findCustomer({ phone, email, givenName, familyName });
    return c ? [c.id] : [];
  } catch {
    return [];
  }
}

// ------------------------ Catalog (services) ------------------------
export async function findServiceVariationIdByName({ serviceName }) {
  const body = { text_filter: serviceName };
  const { items = [] } = await sqFetch('/v2/catalog/search-catalog-items', { method: 'POST', body });
  for (const item of items) {
    const isSvc = item?.product_type === 'APPOINTMENTS_SERVICE' || item?.productType === 'APPOINTMENTS_SERVICE';
    if (isSvc) {
      const vars =
        item?.item_data?.variations ||
        item?.itemData?.variations ||
        [];
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

// ------------------------ Availability & Bookings ------------------------
export async function searchAvailability({
  locationId,
  teamMemberId,
  serviceVariationId,
  startAt,
  endAt
}) {
  // POST /v2/bookings/availability/search (snake_case)
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

// Internal: search bookings for many customer IDs, 31-day window, with pagination
async function searchBookingsByCustomerIds({
  customerIds,
  locationId,
  teamMemberId,
  startAtMin, // ISO
  startAtMax  // ISO (within 31 days of min)
}) {
  const all = [];
  for (const customerId of customerIds) {
    let cursor;
    do {
      const filter = {
        customer_id: customerId,
        start_at_range: { start_at: startAtMin, end_at: startAtMax }
      };
      if (locationId)   filter.location_id = locationId;
      if (teamMemberId) filter.team_member_id = teamMemberId;

      const body = {
        limit: 100,
        cursor,
        query: {
          filter,
          sort: { sort_field: 'START_AT', order: 'ASC' }
        }
      };

      const res = await sqFetch('/v2/bookings/search', { method: 'POST', body });
      all.push(...(res.bookings || []));
      cursor = res.cursor || null;
    } while (cursor);
  }
  return all;
}

/**
 * Look up bookings by identifiers. Supports name/email/phone.
 * Honors Square’s 31-day search window:
 *  - If `date` is provided, searches that exact day (00:00–23:59:59 UTC).
 *  - Else searches [now, now+31d] (or [now-31d, now+31d] if includePast).
 */
export async function lookupUpcomingBookingsByPhoneOrEmail({
  phone,
  email,
  givenName,
  familyName,
  locationId,
  teamMemberId,
  date,          // 'YYYY-MM-DD' optional
  includePast = false
}) {
  const primary = await findCustomer({ phone, email, givenName, familyName });
  if (!primary) return { customer: null, bookings: [] };

  const now = new Date();
  let startAtMin, startAtMax;
  if (date) {
    const [y, m, d] = date.split('-').map(Number);
    startAtMin = new Date(Date.UTC(y, m - 1, d, 0, 0, 0)).toISOString();
    startAtMax = new Date(Date.UTC(y, m - 1, d, 23, 59, 59)).toISOString();
  } else {
    const min = new Date(now);
    if (includePast) min.setDate(min.getDate() - 31);
    const max = new Date(min);
    max.setDate(max.getDate() + 31);
    startAtMin = min.toISOString();
    startAtMax = max.toISOString();
  }

  const bookings = await searchBookingsByCustomerIds({
    customerIds: [primary.id],
    locationId,
    teamMemberId,
    startAtMin,
    startAtMax
  });

  return { customer: primary, bookings };
}

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
          // duration derived from the service variation configuration in Square
        }
      ],
      ...(sellerNote ? { seller_note: sellerNote } : {})
    },
    idempotency_key: randomUUID()
  };

  const { booking } = await sqFetch('/v2/bookings', { method: 'POST', body });
  return booking || null;
}

// Retrieve a single booking (to get its version & segments)
export async function retrieveBooking(bookingId) {
  if (!bookingId) throw new Error('retrieveBooking: bookingId is required');
  const { booking } = await sqFetch(`/v2/bookings/${encodeURIComponent(bookingId)}`, { method: 'GET' });
  return booking || null;
}

export async function cancelBooking({ bookingId, version }) {
  const body = { version };
  const { booking } = await sqFetch(`/v2/bookings/${encodeURIComponent(bookingId)}/cancel`, { method: 'POST', body });
  return booking || null;
}

// Reschedule (update start_at) while preserving service/team/segments.
export async function rescheduleBooking({ bookingId, newStartAt }) {
  if (!bookingId) throw new Error('rescheduleBooking: bookingId is required');
  if (!newStartAt) throw new Error('rescheduleBooking: newStartAt (ISO) is required');

  const current = await retrieveBooking(bookingId);
  if (!current) throw new Error(`Booking not found: ${bookingId}`);

  const booking = {
    id: current.id,
    version: current.version,                       // optimistic lock
    location_id: current.location_id || current.locationId,
    customer_id: current.customer_id || current.customerId || undefined,
    start_at: newStartAt,
    appointment_segments: (current.appointment_segments || current.appointmentSegments || []).map(seg => ({
      service_variation_id: seg.service_variation_id || seg.serviceVariationId,
      service_variation_version: seg.service_variation_version || seg.serviceVariationVersion,
      team_member_id: seg.team_member_id || seg.teamMemberId
    }))
  };

  const body = {
    idempotency_key: randomUUID(),
    booking
  };

  const { booking: updated } = await sqFetch(
    `/v2/bookings/${encodeURIComponent(bookingId)}`,
    { method: 'PUT', body }
  );
  return updated || null;
}
export { toE164US, onlyDigits };
