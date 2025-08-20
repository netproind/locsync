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

// ------------------------ Customers ------------------------
// Try to find a customer by exact email, exact phone (E.164), or fuzzy name.
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

// ------------------------ Catalog (services) ------------------------
export async function findServiceVariationIdByName({ serviceName }) {
  const body = { text_filter: serviceName };
  const { items = [] } = await sqFetch('/v2/catalog/search-catalog-items', { method: 'POST', body });
  for (const item of items) {
    if (item?.product_type === 'APPOINTMENTS_SERVICE' || item?.productType === 'APPOINTMENTS_SERVICE') {
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
  // POST /v2/bookings/availability/search
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
  const filter = { customer_id: customer.id };
  if (locationId)   filter.location_id = locationId;
  if (teamMemberId) filter.team_member_id = teamMemberId;
  if (!includePast) filter.start_at_range = { start_at: nowIso };

  const body = {
    query: {
      filter,
      sort: { sort_field: 'START_AT', order: 'ASC' }
    }
  };

  const { bookings = [] } = await sqFetch('/v2/bookings/search', { method: 'POST', body });
  return { customer, bookings };
}

export async function cancelBooking({ bookingId, version }) {
  const body = { version };
  const { booking } = await sqFetch(`/v2/bookings/${encodeURIComponent(bookingId)}/cancel`, { method: 'POST', body });
  return booking || null;
}
