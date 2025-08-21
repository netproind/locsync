// square.js
import { Client, Environment } from "square";

// Init Square client
const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.NODE_ENV === "production"
    ? Environment.Production
    : Environment.Sandbox,
});

// Example: find booking by customer phone number
export async function handleSquareFindBooking(phone) {
  try {
    const { customersApi } = client;

    // Look up customer by phone
    const customers = await customersApi.searchCustomers({
      query: {
        filter: {
          phoneNumber: { exact: phone },
        },
      },
    });

    if (!customers.result.customers || customers.result.customers.length === 0) {
      return null;
    }

    const customerId = customers.result.customers[0].id;

    // Fetch bookings
    const { bookingsApi } = client;
    const bookings = await bookingsApi.listBookings({ customerId });

    return bookings.result.bookings || [];
  } catch (err) {
    console.error("Square error:", err);
    throw err;
  }
}
