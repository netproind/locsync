// square.js — Square HTTPS helpers (no SDK). Works on Node 20+.
import { randomUUID } from 'node:crypto';

const isProd = (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'production';
const BASE = isProd
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

// Square-Version must be a valid release date.
const SQUARE_VERSION = '2025-07-17';

// ---- small utility: timeout wrapper for fetch (6s) ----
async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(to);
  }
}

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
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined
  }, 6000); // 6s timeout

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

export async function listLocations() {
  const out = await api('/v2/locations', { method: 'GET' });
  return out?.locations || [];
}

// ---------------- Customers ----------------

/** Normalize phone to E.164 (+1XXXXXXXXXX) when US 10 digits are provided. */
function normalizePhoneMaybeUS(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  // fall through: if user already gave +E164, keep as-is
  return phone.startsWith('+') ? phone : `+${digits}`;
}

/** Lookup only (does NOT create) with multiple strategies */
export async function findCustomerSmart({ phone, email, givenName, familyName }) {
  // Strategy 1: by exact email
  if (email) {
    const found = await api('/v2/customers/search', {
      method: 'POST',
      body: { query: { filter: { emailAddress: { exact: String(email).trim().toLowerCase() } } } }
    });
    if (found?.customers?.[0]) return found.customers[0];
  }

  // Strategy 2: by normalized phone (exact match)
  if (phone) {
    const norm = normalizePhoneMaybeUS(phone);
    const found = await api('/v2/customers/search', {
      method: 'POST',
      body: { query: { filter: { phoneNumber: { exact: norm } } } }
    });
    if (found?.customers?.[0]) return found.customers[0];
  }

  // Strategy 3: by name (exact filters; Square supports givenName/familyName filters)
  if (givenName || familyName) {
    const filter = {};
    if (givenName)  filter.givenName  = { exact: givenName };
    if (familyName) filter.familyName = { exact: familyName };

    const found = await api('/v2/customers/search', {
      method: 'POST',
      body: { query: { filter } }
    });
    if (found?.customers?.length) {
      // If multiple matches, return the first; your agent can confirm last 4 phone digits if needed
      return found.customers[0];
    }
  }

  return null;
}

/** Create-or-get (used when booking) */
export async function ensureCustomerByPhoneOrEmail({ givenName, phone, email }) {
  const existing = await findCustomerSmart({ phone, email, givenName });
  if (existing) return existing;
  const created = await api('/v2/customers', {
    method: 'POST',
    body: {
      givenName: givenName || 'Caller',
      phoneNumber: normalizePhoneMaybeUS(phone),
      emailAddress: email?.trim()?.toLowerCase()
    }
  });
  return created.customer;
}

// ---------------- Catalog / Services ----------------

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

// ---------------- Availability / Bookings ----------------

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

/** ---- Booking lookup ---- */

// GET /v2/bookings with filters (customer_id, team_member_id, location_id, start_at_min/max)
export async function listBookings({
  customerId,
  teamMemberId,
  locationId,
  startAtMin,
  startAtMax,
  status, // e.g., "ACCEPTED"
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

/** Find upcoming bookings for a customer using phone/email/name. */
export async function lookupUpcomingBookingsByPhoneOrEmail({
  phone,
  email,
  givenName,
  familyName,
  locationId,
  teamMemberId,
  includePast = false
}) {
  const customer = await findCustomerSmart({ phone, email, givenName, familyName });
  if (!customer?.id) {
    return { customer: null, bookings: [] };
  }

  const nowIso = new Date().toISOString();
  const { bookings } = await listBookings({
    customerId: customer.id,
    locationId,
    teamMemberId,
    startAtMin: includePast ? undefined : nowIso,
    status: 'ACCEPTED',
    limit: 100
  });

  bookings.sort((a, b) => (a.startAt || '').localeCompare(b.startAt || ''));
  return { customer, bookings };
}
