// square.js — Square API helpers (ESM)

// Square SDK is CommonJS → import via default
import Square from 'square';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

const { Client, Environment } = Square;

// ---------- ENV ----------
const {
  SQUARE_ACCESS_TOKEN,
  NODE_ENV,
  SQUARE_DEFAULT_LOCATION_ID,
  SQUARE_DEFAULT_TEAM_MEMBER_ID
} = process.env;

if (!SQUARE_ACCESS_TOKEN) {
  console.error('❌ Missing SQUARE_ACCESS_TOKEN');
  process.exit(1);
}

// ---------- CLIENT ----------
export const squareClient = new Client({
  accessToken: SQUARE_ACCESS_TOKEN,
  environment: NODE_ENV === 'production'
    ? Environment.Production
    : Environment.Sandbox
});

// ---------- HELPERS ----------
export function toE164US(raw) {
  if (!raw) return null;
  try {
    const num = parsePhoneNumberFromString(raw, 'US');
    return num ? num.number : null;
  } catch {
    return null;
  }
}

// ---------- API CALLS ----------
export async function listLocations() {
  const { result } = await squareClient.locationsApi.listLocations();
  return result.locations || [];
}

export async function searchAvailability({ locationId, teamMemberId, serviceVariationId, startAt, endAt }) {
  const { result } = await squareClient.bookingsApi.searchAvailability({
    query: {
      filter: {
        locationId,
        segmentFilters: [
          {
            serviceVariationId,
            teamMemberIdFilter: { any: [teamMemberId] }
          }
        ],
        startAt,
        endAt
      }
    }
  });
  return result.availabilities || [];
}

export async function createBooking({ customerId, locationId, teamMemberId, serviceVariationId, startAt }) {
  const { result } = await squareClient.bookingsApi.createBooking({
    booking: {
      locationId,
      customerId,
      startAt,
      appointmentSegments: [
        {
          teamMemberId,
          serviceVariationId,
          durationMinutes: 60 // adjust as needed
        }
      ]
    }
  });
  return result.booking;
}

export async function ensureCustomerByPhoneOrEmail({ phone, email, givenName, familyName }) {
  let customerId;

  const searchPayload = {
    query: {
      filter: {
        ...(phone ? { phoneNumber: { exact: phone } } : {}),
        ...(email ? { emailAddress: { exact: email } } : {})
      }
    }
  };

  const { result } = await squareClient.customersApi.searchCustomers(searchPayload);
  if (result.customers && result.customers.length) {
    customerId = result.customers[0].id;
  } else {
    const { result: createRes } = await squareClient.customersApi.createCustomer({
      givenName,
      familyName,
      phoneNumber: phone,
      emailAddress: email
    });
    customerId = createRes.customer?.id;
  }

  return customerId;
}

export async function findServiceVariationIdByName(serviceName) {
  const { result } = await squareClient.catalogApi.listCatalog();
  const items = result.objects || [];
  const service = items.find(
    o => o.type === 'ITEM' && o.itemData?.name?.toLowerCase() === serviceName.toLowerCase()
  );
  if (!service) return null;
  return service.itemData.variations?.[0]?.id || null;
}

export async function resolveCustomerIds({ phone, email }) {
  const { result } = await squareClient.customersApi.searchCustomers({
    query: {
      filter: {
        ...(phone ? { phoneNumber: { exact: phone } } : {}),
        ...(email ? { emailAddress: { exact: email } } : {})
      }
    }
  });
  return (result.customers || []).map(c => c.id);
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
  const customerIds = await resolveCustomerIds({ phone, email });
  if (!customerIds.length) return { bookings: [] };

  const { result } = await squareClient.bookingsApi.searchBookings({
    query: {
      filter: {
        locationId,
        customerIds,
        ...(includePast ? {} : { startAt: { min: new Date().toISOString() } })
      }
    }
  });

  return { bookings: result.bookings || [] };
}

export async function retrieveBooking(bookingId) {
  const { result } = await squareClient.bookingsApi.retrieveBooking(bookingId);
  return result.booking;
}

export async function rescheduleBooking(bookingId, newStartAt) {
  const { result } = await squareClient.bookingsApi.updateBooking({
    bookingId,
    booking: { startAt: newStartAt }
  });
  return result.booking;
}

export async function cancelBooking(bookingId) {
  const { result } = await squareClient.bookingsApi.cancelBooking(bookingId);
  return result.booking;
}
