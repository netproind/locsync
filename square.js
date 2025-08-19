// square.js (ESM)
import { Client, Environment, v1 } from 'square';

const env = (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'production'
  ? Environment.Production
  : Environment.Sandbox;

export const square = new Client({
  environment: env,
  accessToken: process.env.SQUARE_ACCESS_TOKEN
});

// Convenience getters
export const locationsApi     = square.locationsApi;
export const bookingsApi      = square.bookingsApi;
export const availabilityApi  = square.availabilityApi;
export const customersApi     = square.customersApi;
export const catalogApi       = square.catalogApi;
export const teamApi          = square.teamApi;

// Helpers you can call from the voice "tools"
export async function ensureCustomerByPhoneOrEmail({ givenName, phone, email }) {
  // Try to find existing
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
  // Create new
  const res = await customersApi.createCustomer({
    givenName: givenName || 'Caller',
    phoneNumber: phone,
    emailAddress: email
  });
  return res.result.customer;
}

export async function findServiceVariationIdByName({ serviceName }) {
  // Search catalog for Appointments service variations
  const res = await catalogApi.searchCatalogItems({ textFilter: serviceName });
  const items = res?.result?.items || [];
  for (const item of items) {
    if (item?.productType === 'APPOINTMENTS_SERVICE') {
      const vars = item?.itemData?.variations || [];
      // Return first variation; customize if you want finer choice
      if (vars[0]?.id) return vars[0].id;
    }
  }
  return null;
}

export async function searchAvailability({
  locationId,
  teamMemberId,
  serviceVariationId,
  startAt, // ISO start range
  endAt    // ISO end range
}) {
  const res = await availabilityApi.searchAvailability({
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
  return res.result.availabilities || [];
}

export async function createBooking({
  locationId,
  teamMemberId,
  customerId,
  serviceVariationId,
  startAt, // ISO start of the slot
  sellerNote // optional
}) {
  // Duration and service details come from the service variation configuration.
  const body = {
    booking: {
      locationId,
      startAt,
      customerId,
      appointmentSegments: [{
        durationMinutes: undefined, // Square derives duration from the service variation
        serviceVariationId,
        teamMemberId
      }],
      sellerNote
    },
    idempotencyKey: crypto.randomUUID()
  };
  const res = await bookingsApi.createBooking(body);
  return res.result.booking;
}

export async function cancelBooking({ bookingId, version }) {
  const res = await bookingsApi.cancelBooking(bookingId, { version });
  return res.result.booking;
}
