// square.js — Square HTTPS helpers (no SDK). Works on Node 20+.
import { randomUUID } from 'node:crypto';

const isProd = (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'production';
const BASE = isProd
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

// Square-Version must be a valid release date.
const SQUARE_VERSION = '2025-07-17';

function authHeaders() {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) throw new Error('Missing SQUARE_ACCESS_TOKEN');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Square-Version': SQUARE_VERSION
  };
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.errors?.map(e => `${e.category}:${e.code}:${e.detail}`).join(' | ')
      || `HTTP ${res.status}`;
    throw new Error(`Square API ${method} ${path} failed: ${msg}`);
  }
  return json;
}

/** ===== Public helpers your app uses ===== **/

// For /dev/square/ping
export async function listLocations() {
  const out = await api('/v2/locations', { method: 'GET' });
  return out?.locations || [];
}

// ---------- Customers ----------

/** Create-or-get customer (used for making bookings) */
export async function ensureCustomerByPhoneOrEmail({ givenName, phone, email }) {
  const existing = await findCustomerByPhoneOrEmail({ phone, email });
  if (existing) return existing;
  const created = await api('/v2/customers', {
    method: 'POST',
    body: {
      givenName: givenName || 'Caller',
      phoneNumber: phone,
      emailAddress: email
    }
  });
  return created.customer;
}

/** Lookup only (does NOT create) */
export async function findCustomerByPhoneOrEmail({ phone, email }) {
  // Search by email first (if provided)
  if (email) {
    const found = await api('/v2/customers/search', {
      method: 'POST',
      body: { query: { filter: { emailAddress: { exact: email } } } }
    });
    if (found?.customers?.[0]) return found.customers[0];
  }
  // Then by phone
  if (phone) {
    const found = await api('/v2/customers/search', {
      method: 'POST',
      body: { query: { filter: { phoneNumber: { exact: phone } } } }
    });
    if (found?.customers?.[0]) return found.customers[0];
  }
  return null;
}

// ---------- Catalog / Services ----------

export async function findServiceVariationIdByName({ serviceName }) {
  const out = await api('/v2/catalog/search-catalog-items', {
    method: 'POST',
    body: {
      textFilter: serviceName,
      productTypes: ['APPOINTMENTS_SERVICE']
    }
  });
  const items = out?.items || [];
  for (const item of items) {
    if (item?.productType === 'APPOINTMENTS_SERVICE') {
      const vars = item?.itemData?.variations || [];
      if (vars[0]?.id) return vars[0].id;
    }
  }
  return null;
}

async function getServiceVariationVersion(serviceVariationId) {
  const out = await api(`/v2/catalog/object/${serviceVariationId}?include_related_objects=false`, {
    method: 'GET'
  });
  return out?.object?.version ?? null;
}

// ---------- Availability / Bookings ----------

export async function searchAvailability({
  locationId,
  teamMemberId,
  serviceVariationId,
  startAt,
  endAt
}) {
  const out = await api('/v2/bookings/availability/search-availability', {
    method: 'POST',
    body: {
      query: {
        filter: {
          locationId,
          segmentFilters: [
            {
              serviceVariationId,
              teamMemberIdFilter: { any: [teamMemberId] }
            }
          ],
          startAtRange: { startAt, endAt }
        }
      }
    }
  });
  return out?.availabilities || [];
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
    throw new Error('Could not resolve serviceVariationVersion for the chosen service.');
  }

  const body = {
    booking: {
      locationId,
      startAt,
      customerId,
      appointmentSegments: [
        {
          serviceVariationId,
          serviceVariationVersion,
          teamMemberId
        }
      ],
      sellerNote
    },
    idempotencyKey: randomUUID()
  };
  const out = await api('/v2/bookings', { method: 'POST', body });
  return out.booking;
}

export async function cancelBooking({ bookingId, version }) {
  const out = await api(`/v2/bookings/${bookingId}/cancel`, {
    method: 'POST',
    body: { version }
  });
  return out.booking;
}

/** ---- NEW: simple booking lookup by customer ---- **/

/**
 * List bookings via GET /v2/bookings with filters.
 * Filters supported by Square include: customer_id, team_member_id, location_id,
 * start_at_min, start_at_max, limit, cursor, status.
 */
export async function listBookings({
  customerId,
  teamMemberId,
  locationId,
  startAtMin,
  startAtMax,
  status, // e.g., "ACCEPTED", "CANCELLED"
  limit = 50,
  cursor
}) {
  const params = new URLSearchParams();
  if (customerId)  params.set('customer_id', customerId);
  if (teamMemberId) params.set('team_member_id', teamMemberId);
  if (locationId)  params.set('location_id', locationId);
  if (startAtMin)  params.set('start_at_min', startAtMin);
  if (startAtMax)  params.set('start_at_max', startAtMax);
  if (status)      params.set('status', status);
  if (limit)       params.set('limit', String(limit));
  if (cursor)      params.set('cursor', cursor);

  const qs = params.toString() ? `?${params.toString()}` : '';
  const out = await api(`/v2/bookings${qs}`, { method: 'GET' });
  return {
    bookings: out?.bookings || [],
    cursor: out?.cursor || null
  };
}

/**
 * Find the next upcoming booking for a customer (by phone/email).
 * If none upcoming, returns empty array (or past if includePast=true).
 */
export async function lookupUpcomingBookingsByPhoneOrEmail({
  phone,
  email,
  locationId,       // optional filter
  teamMemberId,     // optional filter
  includePast = false
}) {
  const customer = await findCustomerByPhoneOrEmail({ phone, email });
  if (!customer?.id) {
    return { customer: null, bookings: [] };
  }

  // Query window: from "now" forward (UTC ISO) for upcoming
  const nowIso = new Date().toISOString();
  const { bookings } = await listBookings({
    customerId: customer.id,
    locationId,
    teamMemberId,
    startAtMin: includePast ? undefined : nowIso,
    status: 'ACCEPTED',
    limit: 100
  });

  // Sort by startAt ascending
  bookings.sort((a, b) => (a.startAt || '').localeCompare(b.startAt || ''));
  return { customer, bookings };
}
