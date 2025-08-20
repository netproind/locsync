// square.js — Square SDK helpers (ESM, Node 20)
// Works with "square" SDK v43+ (CommonJS package used via default import)

import squarePkg from 'square';
import { randomUUID } from 'node:crypto';

const { Client, environments } = squarePkg;

// ---- Environment & Client ---------------------------------------------------
const envName = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const environment =
  envName === 'production' ? environments.production : environments.sandbox;

if (!process.env.SQUARE_ACCESS_TOKEN) {
  console.error('Missing SQUARE_ACCESS_TOKEN in environment.');
}

export const square = new Client({
  environment,
  accessToken: process.env.SQUARE_ACCESS_TOKEN
});

// Convenience APIs
const locationsApi = square.locationsApi;
const bookingsApi  = square.bookingsApi;
const customersApi = square.customersApi;
const catalogApi   = square.catalogApi;
const teamApi      = square.teamApi; // not used directly but kept for completeness

// ---- Utils ------------------------------------------------------------------
function onlyDigits(s = '') {
  return String(s || '').replace(/\D+/g, '');
}
function toE164US(phone) {
  // Accepts E.164, 10-digit US, or with punctuation; returns +1XXXXXXXXXX if looks US 10-digit
  const trimmed = (phone || '').trim();
  if (/^\+/.test(trimmed)) return trimmed; // already E.164
  const digits = onlyDigits(trimmed);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // Fallback: if unknown length, just prefix with + (Square may still accept if truly E.164)
  return trimmed.startsWith('+') ? trimmed : `+${digits}`;
}

// ---- Locations --------------------------------------------------------------
export async function listLocations() {
  const { result } = await locationsApi.listLocations();
  return result?.locations || [];
}

// ---- Customers --------------------------------------------------------------
/**
 * Finds a single customer by exact phone/email, otherwise by name.
 * Returns the first best match (you can refine later to disambiguate).
 */
export async function findCustomer({ phone, email, givenName, familyName }) {
  // Prefer exact phone/email lookups first (fast & precise)
  if (email) {
    const { result } = await customersApi.searchCustomers({
      query: { filter: { email_address: { exact: email.trim() } } }
    });
    if (result?.customers?.[0]) return result.customers[0];
  }
  if (phone) {
    const e164 = toE164US(phone);
    const { result } = await customersApi.searchCustomers({
      query: { filter: { phone_number: { exact: e164 } } }
    });
    if (result?.customers?.[0]) return result.customers[0];
  }

  // Fall back to name search (fuzzy)
  if (givenName || familyName) {
    const filter = {};
    if (givenName)   filter.given_name  = { fuzzy: givenName.trim() };
    if (familyName)  filter.family_name = { fuzzy: familyName.trim() };
    const { result } = await customersApi.searchCustomers({ query: { filter } });
    if (result?.customers?.[0]) return result.customers[0];
  }

  return null;
}

/**
 * Ensure a customer exists; try to find by email/phone, else create.
 */
export async function ensureCustomerByPhoneOrEmail({ givenName, phone, email }) {
  const existing = await findCustomer({ phone, email });
  if (existing) return existing;

  const body = {
    givenName: givenName || 'Caller'
  };
  if (email) body.emailAddress = email.trim();
  if (phone) body.phoneNumber = toE164US(phone);

  const { result } = await customersApi.createCustomer(body);
  return result?.customer || null;
}

// ---- Catalog (Services) -----------------------------------------------------
/**
 * Returns the first Appointments service variation id that matches text.
 */
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

// ---- Availability & Bookings ------------------------------------------------
/**
 * Search availability for a specific service variation, team member, and location
 * within a start/end range (ISO 8601).
 */
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

/**
 * Create a booking at startAt for the given customer/service/team/location.
 * We fetch serviceVariationVersion which Square requires.
 */
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
          // Duration is derived from the service variation configuration
        }
      ],
      sellerNote
    },
    idempotencyKey: randomUUID()
  };

  const { result } = await bookingsApi.createBooking(body);
  return result?.booking || null;
}

/**
 * Lookup upcoming (or all) bookings for a customer by phone/email/name.
 * includePast=false → only future bookings (>= now).
 * Returns { customer, bookings }.
 */
export async function lookupUpcomingBookingsByPhoneOrEmail({
  phone,
  email,
  givenName,
  familyName,
  locationId,
  teamMemberId,
  includePast = false
}) {
  // 1) Resolve customer
  const customer = await findCustomer({ phone, email, givenName, familyName });
  if (!customer) {
    return { customer: null, bookings: [] };
  }

  // 2) Build booking search
  const nowIso = new Date().toISOString();
  const filter = {
    customerId: customer.id
  };
  if (locationId)   filter.locationId = locationId;
  if (teamMemberId) filter.teamMemberId = teamMemberId;
  if (!includePast) {
    filter.startAtRange = { startAt: nowIso };
  }

  const body = { query: { filter, sort: { sortField: 'START_AT', order: 'ASC' } } };

  const { result } = await bookingsApi.searchBookings(body);
  const bookings = result?.bookings || [];

  return { customer, bookings };
}

// Optional: cancel booking helper (not used by index.js right now)
export async function cancelBooking({ bookingId, version }) {
  const { result } = await bookingsApi.cancelBooking(bookingId, { version });
  return result?.booking || null;
}
