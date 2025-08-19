// square.js (ESM-friendly import for CommonJS SDK)
import squarePkg from 'square';
import { randomUUID } from 'node:crypto';

const { Client, Environment } = squarePkg;

const env = (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'production'
  ? Environment.Production
  : Environment.Sandbox;

export const square = new Client({
  environment: env,
  accessToken: process.env.SQUARE_ACCESS_TOKEN
});

// Convenience getters
export const locationsApi = square.locationsApi;
export const bookingsApi  = square.bookingsApi;
export const customersApi = square.customersApi;
export const catalogApi   = square.catalogApi;
export const teamApi      = square.teamApi;

// --- Helpers ---
export async function ensureCustomerByPhoneOrEmail({ givenName, phone, email }) {
  if (email) {
    const found = await customersApi.searchCustomers({
      query: { filter: { emailAddress: { exact: email } } }
    });
    if (found?.result?.customers?.[0]) return found.result.customers[0];
  }
  if (phone) {
    const found = await customersApi.searchCustomers({
      query: { filter: { phoneNumber: { exact: phone } } }
    });
    if (found?.result?.customers?.[0]) return found.result.customers[0];
  }
  const res = await customersApi.createCustomer({
    givenName: givenName || 'Caller',
    phoneNumber: phone,
    emailAddress: email
  });
  return res.result.customer;
}

export async function findServiceVariationIdByName({ serviceName }) {
  const res = await catalogApi.searchCatalogItems({ textFilter: serviceName });
  const items = res?.result?.items || [];
  for (const item of items) {
    if (item?.productType === 'APPOINTMENTS_SERVICE') {
      const vars = item?.itemData?.variations || [];
      if (vars[0]?.id) return vars[0].id;
    }
  }
  return null;
}

async function getServiceVariationVersion(serviceVariationId) {
  const res = await catalogApi.retrieveCatalogObject(serviceVariationId, false);
  return res?.result?.object?.version ?? null;
}

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
        segmentFilters: [{
          serviceVariationId,
          teamMemberIdFilter: { any: [teamMemberId] }
        }],
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
      appointmentSegments: [{
        serviceVariationId,
        serviceVariationVersion,
        teamMemberId
      }],
      sellerNote
    },
    idempotencyKey: randomUUID()
  };

  const { result } = await bookingsApi.createBooking(body);
  return result.booking;
}

export async function cancelBooking({ bookingId, version }) {
  const { result } = await bookingsApi.cancelBooking(bookingId, { version
