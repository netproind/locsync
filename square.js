import square from 'square';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

const { Client, Environment } = square;

export const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.SQUARE_ENV === 'production'
      ? Environment.Production
      : Environment.Sandbox
});

export function toE164US(input) {
  try {
    const num = parsePhoneNumberFromString(input, 'US');
    return num?.isValid() ? num.number : null;
  } catch {
    return null;
  }
}

// Example helpers (fill these in as you go)
export async function listLocations() {
  return squareClient.locationsApi.listLocations();
}

export async function lookupUpcomingBookingsByPhoneOrEmail({ phone, email }) {
  // Placeholder until you flesh out Square booking search
  return { bookings: [] };
}
