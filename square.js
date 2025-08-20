// square.js — Square HTTPS helpers (no SDK). Works on Node 20+.
import { randomUUID } from 'node:crypto';

const isProd = (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'production';
const BASE = isProd
  ? 'https://connect.squareup.com'
  : 'https://connect.squareupsandbox.com';

// Square-Version must be a valid release date (kept current).
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

// Customers
export async function ensureCustomerByPhoneOrEmail({ givenName, phone, email }) {
  // Search by email
  if (email) {
    const found = await api('/v2/customers/search', {
      method: 'POST',
      body: { query: { filter: { emailAddress: { exact: email } } } }
    });
    if (found?.customers?.[0]) return found.customers[0];
  }
  // Search by phone
  if (phone) {
    const found = await api('/v2/customers/search', {
      method: 'POST',
      body: { query: { filter: { phoneNumber: { exact: phone } } } }
    });
    if (found?.customers?.[0]) return found.customers[0];
  }
  // Create
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

// Find a service variation id by service name (Appointments Service)
export async function findServiceVariationIdByName({ serviceName }) {
  const out = await api('/v2/catalog/search-catalog-items', {
    method: 'POST',
    body: {
      textFilter: serviceName,
      // Narrow to appointment services
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

// Needed by createBooking (Square requires the service variation version)
async function getServiceVariationVersion(serviceVariationId) {
  const out = await api(`/v2/catalog/object/${serviceVariationId}?include_related_objects=false`, {
    method: 'GET'
  });
  return out?.object?.version ?? null;
}

// Availability
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

// Create booking
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

// Cancel booking (not used yet, but handy)
export async function cancelBooking({ bookingId, version }) {
  const out = await api(`/v2/bookings/${bookingId}/cancel`, {
    method: 'POST',
    body: { version }
  });
  return out.booking;
}

// Team search (if you need to discover team member IDs programmatically)
export async function searchTeamMembers() {
  const out = await api('/v2/team-members/search', {
    method: 'POST',
    body: {}
  });
  return out?.teamMembers || [];
}
