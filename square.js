// square.js

// Import Square SDK correctly (CommonJS under the hood)
import pkg from 'square';
const { Client, Environment } = pkg;

// Import phone number formatter
import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Format phone numbers into E.164 (US standard).
 * Example: (555) 123-4567 → +15551234567
 */
export function toE164US(phone) {
  const parsed = parsePhoneNumberFromString(phone, 'US');
  return parsed ? parsed.number : phone;
}

/**
 * Square client setup.
 * Access token and environment are pulled from environment variables.
 */
export const squareClient = new Client({
  environment: process.env.SQUARE_ENV === 'production'
    ? Environment.Production
    : Environment.Sandbox,  // defaults to sandbox unless explicitly production
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
});

/**
 * Example helper – find upcoming bookings for a customer.
 */
export async function findUpcomingBookings(customerId) {
  try {
    const { result } = await squareClient.bookingsApi.listBookings({
      customerId,
      limit: 5,
    });
    return result.bookings || [];
  } catch (err) {
    console.error('Error fetching bookings:', err);
    return [];
  }
}
