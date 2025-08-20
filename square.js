// square.js — Square SDK helpers (robust across SDK versions)
import squarePkg from 'square';
import { randomUUID } from 'node:crypto';

// Handle both ESM/CJS and both env enums:
//   - older/newer SDKs: Environment.{Production,Sandbox}
//   - some builds:     environments.{production,sandbox}
const Client =
  squarePkg.Client || squarePkg.default?.Client;

const EnvironmentObj =
  squarePkg.Environment ||
  squarePkg.environments ||
  squarePkg.EnvironmentEnum ||
  squarePkg.default?.Environment ||
  squarePkg.default?.environments;

if (!Client || !EnvironmentObj) {
  throw new Error('Square SDK not loaded as expected — Client/Environment missing from package "square".');
}

// Map our SQUARE_ENV to the SDK’s enum (handles both capitalized and lowercase variants)
function resolveSdkEnv(s) {
  const prod =
    EnvironmentObj.Production ??
    EnvironmentObj.production;
  const sand =
    EnvironmentObj.Sandbox ??
    EnvironmentObj.sandbox;

  const wanted = (s || 'sandbox').toLowerCase() === 'production' ? prod : sand;
  if (!wanted) {
    throw new Error('Could not resolve Square environment enum from SDK.');
  }
  return wanted;
}

const env = resolveSdkEnv(process.env.SQUARE_ENV);

export const square = new Client({
  environment: env,
  accessToken: process.env.SQUARE_ACCESS_TOKEN
});

// Convenience APIs
export const locationsApi = square.locationsApi;
export const bookingsApi  = square.bookingsApi;
export const customersApi = square.customersApi;
export const catalogApi   = square.catalogApi;
export const teamApi      = square.teamApi;

// ---------- Helpers ----------

// Find or create a customer by email/phone
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

// Look up a service variation ID by (partial) service name
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

// Retrieve the version required for createBooking
async function getServiceVariationVersion(serviceVariationId) {
  const res = await catalogApi.retrieveCatalogObject(serviceVariationId, false);
  return res?.result?.object?.version ?? null;
}

// Search availability
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

// Create a booking
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
          // Duration comes from the service variation config in Square
          serviceVariationId,
          serviceVariationVersion,
          teamMemberId
        }
      ],
      sellerNote
    },
    idempotencyKey: randomUUID()
  };

  const { result } = await bookingsApi.createBooking(body);
  return result.booking;
}

// Cancel a booking
export async function cancelBooking({ bookingId, version }) {
  const { result } = await bookingsApi.cancelBooking(bookingId, { version });
  return result.booking;
}
