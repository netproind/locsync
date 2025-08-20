// square.js — Square SDK helpers (ESM, Node 20)
// Uses customUrl instead of Environment/environments to avoid SDK export issues.

import squarePkg from 'square';
import { randomUUID } from 'node:crypto';

// Be resilient to different module shapes
const Client =
  squarePkg?.Client ||
  squarePkg?.default?.Client ||
  (squarePkg && squarePkg['Client']);

if (!Client) {
  throw new Error('Square SDK: Client export not found. Is the "square" package installed?');
}

// ---- Resolve base URL by env name (no Environment enum needed) -------------
const envName = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const baseUrl =
  envName === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

if (!process.env.SQUARE_ACCESS_TOKEN) {
  console.error('Missing SQUARE_ACCESS_TOKEN in environment.');
}

// ---- Client ----------------------------------------------------------------
export const square = new Client({
  customUrl: baseUrl,
  accessToken: process.env.SQUARE_ACCESS_TOKEN
});

// Convenience APIs
const locationsApi = square.locationsApi;
const bookingsApi  = square.bookingsApi;
const customersApi = square.customersApi;
const catalogApi   = square.catalogApi;

// ---- Utils -----------------------------------------------------------------
function onlyDigits(s = '') {
  return String(s || '').replace(/\D+/g, '');
}
function toE164US(phone) {
  const trimmed = (phone || '').trim();
  if (/^\+/.test(trimmed)) return trimmed;       // already E.164
  const digits = onlyDigits(trimmed);
  if (digits.length === 10) return `+1${digits}`; // assume US
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed.startsWith('+') ? trimmed : `+${digits}`;
}

// ---- Locations --------------------------------------------------------------
export async function listLocations() {
  const { result } = await locationsApi.listLocations();
  return result?.locations || [];
}

// ---- Customers --------------------------------------------------------------
export async function findCustomer({ phone, email, givenName, familyName }) {
  // exact email
  if (email) {
    const { result } = await customersApi.searchCustomers({
      query: { filter: { email_address: { exact: String(email).trim() } } }
    });
    if (result?.customers?.[0]) return result.customers[0];
  }
  // exact phone (E.164)
  if (phone) {
    const e164 = toE164US(phone);
    const { result } = await customersApi.searchCustomers({
      query: { filter: { phone_number: { exact: e164 } } }
    });
    if (result?.customers?.[0]) return result.customers[0];
  }
  // fuzzy name
  if (givenName || familyName) {
    const filter = {};
    if (givenName)  filter.given_name  = { fuzzy: String(givenName).trim() };
    if (familyName) filter.family_name = { fuzzy: String(familyName).trim() };
    const { result } = await customersApi.searchCustomers({ query: { filter } });
    if (result?.customers?.[0]) return result.customers[0];
  }
  return null;
}

export async function ensureCustomerByPhoneOrEmail({ givenName, phone, email }) {
  const existing = await findCustomer({ phone, email });
  if (existing) return existing;

  const body = { givenName: givenName || 'Caller' };
  if (email) body.emailAddress = String(email).trim();
  if (phone) body.phoneNumber  = toE164US(phone);

  const { result } = await customersApi.createCustomer(body);
  return result?.customer || null;
}

// ---- Catalog (Services) -----------------------------------------------------
export async function findServiceVariationIdByName({ serviceName }) {
  const { result } = await catalogApi.searchCatalogItems({ textFilter: serviceName });
  const items = result?.items || [];
  for (const item of items) {
    if (item?.productType === 'APPOINTMENTS_SERVICE') {
      const vars = item?.itemData?.variations || [];
      if (vars[0]?.id) return vars[0].id;
    }
  }
  return null;
}

async function getServiceVariationVersion(serviceVariationId) {
  const { result } = await catalogApi.retrieveCatalogObject(serviceVariationId, false);
  return result?.object?.version ?? null;
}

// ---- Availability & Bookings -----------------------------------------------
export async function searchAvailability({
  locationId,
  teamMemberId,
  serviceVariationId,
  startAt,
  endAt
}) {
  const { result } = await bookingsApi.searchAvailability({
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
  });
  return result?.availabilities || [];
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
      locationId,
      startAt,
      customerId,
      appointmentSegments: [
        {
          serviceVariationId,
          serviceVariationVersion,
          teamMemberId
          // duration is derived from the service variation configuration
        }
      ],
      sellerNote
    },
    idempotencyKey: randomUUID()
  };

  const { result } = await bookingsApi.createBooking(body);
  return result?.booking || null;
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
  const filter = { customerId: customer.id };
  if (locationId)   filter.locationId = locationId;
  if (teamMemberId) filter.teamMemberId = teamMemberId;
  if (!includePast) filter.startAtRange = { startAt: nowIso };

  const body = { query: { filter, sort: { sortField: 'START_AT', order: 'ASC' } } };
  const { result } = await bookingsApi.searchBookings(body);
  const bookings = result?.bookings || [];

  return { customer, bookings };
}

// Optional
export async function cancelBooking({ bookingId, version }) {
  const { result } = await bookingsApi.cancelBooking(bookingId, { version });
  return result?.booking || null;
}
