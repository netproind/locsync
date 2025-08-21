// square.js — Square API helpers
import { Client, Environment } from 'square';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.NODE_ENV === 'production'
    ? Environment.Production
    : Environment.Sandbox
});

const { customersApi, bookingsApi, catalogApi } = client;

// -------- PHONE NORMALIZER --------
export function toE164US(phone) {
  if (!phone) return null;
  try {
    const parsed = parsePhoneNumberFromString(phone, 'US');
    return parsed?.isValid() ? parsed.number : null;
  } catch {
    return null;
  }
}

// -------- CUSTOMER HELPERS --------
export async function ensureCustomerByPhoneOrEmail({ phone, email }) {
  try {
    const searchReq = {
      query: {
        filter: {
          emailAddress: email ? { exact: email } : undefined,
          phoneNumber: phone ? { exact: phone } : undefined
        }
      }
    };
    const res = await customersApi.searchCustomers(searchReq);
    if (res?.result?.customers?.length) {
      return res.result.customers[0];
    }

    const create = await customersApi.createCustomer({
      emailAddress: email || undefined,
      phoneNumber: phone || undefined
    });
    return create.result.customer;
  } catch (e) {
    throw new Error("Customer lookup failed: " + e.message);
  }
}

// -------- BOOKINGS LOOKUP --------
export async function lookupUpcomingBookingsByPhoneOrEmail({ phone, email, includePast }) {
  try {
    const searchReq = {
      query: {
        filter: {
          customerIds: [],
          locationId: process.env.SQUARE_DEFAULT_LOCATION_ID
        }
      }
    };

    // first resolve customer
    const customer = await ensureCustomerByPhoneOrEmail({ phone, email });
    if (!customer) return { bookings: [] };

    searchReq.query.filter.customerIds.push(customer.id);

    const res = await bookingsApi.searchBookings(searchReq);
    let bookings = res?.result?.bookings || [];

    if (!includePast) {
      const now = new Date();
      bookings = bookings.filter(b => new Date(b.startAt || b.start_at) >= now);
    }

    return { bookings };
  } catch (e) {
    throw new Error("Booking lookup failed: " + e.message);
  }
}

// -------- BOOKING CREATE --------
export async function createBooking({ customer, service, datetime }) {
  try {
    if (!customer?.id) throw new Error("Missing customer.id");
    if (!datetime) throw new Error("Missing datetime");

    // Find service variation ID by name
    const catalog = await catalogApi.listCatalog(undefined, 'ITEM_VARIATION');
    const variation = catalog.result.objects.find(o =>
      o.itemVariationData?.name?.toLowerCase().includes(service.toLowerCase())
    );
    if (!variation) throw new Error("Service not found: " + service);

    const req = {
      booking: {
        customerId: customer.id,
        locationId: process.env.SQUARE_DEFAULT_LOCATION_ID,
        startAt: new Date(datetime).toISOString(),
        appointmentSegments: [
          {
            durationMinutes: 60,
            serviceVariationId: variation.id,
            teamMemberId: process.env.SQUARE_DEFAULT_TEAM_MEMBER_ID
          }
        ]
      }
    };
    const res = await bookingsApi.createBooking(req);
    return res.result.booking;
  } catch (e) {
    throw new Error("Booking create failed: " + e.message);
  }
}

// -------- BOOKING RESCHEDULE --------
export async function rescheduleBooking(bookingId, newDateTime) {
  try {
    const res = await bookingsApi.updateBooking(bookingId, {
      booking: { startAt: new Date(newDateTime).toISOString() }
    });
    return res.result.booking;
  } catch (e) {
    throw new Error("Reschedule failed: " + e.message);
  }
}

// -------- BOOKING CANCEL --------
export async function cancelBooking(bookingId) {
  try {
    await bookingsApi.cancelBooking(bookingId, {
      bookingVersion: 1 // optimistic concurrency; update if needed
    });
    return true;
  } catch (e) {
    throw new Error("Cancel failed: " + e.message);
  }
}

// -------- AVAILABILITY SEARCH --------
export async function searchAvailability({ service, startAt, endAt }) {
  try {
    const res = await bookingsApi.searchAvailability({
      query: {
        filter: {
          locationId: process.env.SQUARE_DEFAULT_LOCATION_ID,
          segmentFilters: [
            {
              serviceVariationId: service,
              teamMemberIdFilter: [process.env.SQUARE_DEFAULT_TEAM_MEMBER_ID]
            }
          ]
        },
        startAt,
        endAt
      }
    });
    return res.result.availabilities || [];
  } catch (e) {
    throw new Error("Availability search failed: " + e.message);
  }
}
