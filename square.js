// square.js — REST-only implementation (no SDK), Node 20 ESM
import { randomUUID } from 'node:crypto';

const envName = (process.env.SQUARE_ENV || 'sandbox').toLowerCase();
const BASE_URL =
  envName === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';

const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('Missing SQUARE_ACCESS_TOKEN in environment.');
}

const SQUARE_VERSION = '2025-05-15';

// ------------------------ core fetch wrapper ------------------------
async function sqFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Square-Version': SQUARE_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) {
    const first = Array.isArray(json?.errors) ? json.errors[0] : null;
    const code = first?.code || '';
    const detail = first?.detail || '';
    const msg = `${res.status} ${res.statusText}${code ? `:${code}` : ''}${detail ? `:${detail}` : ''}`;
    throw new Error(`Square API ${method} ${path} failed: ${msg}`);
  }
  return json;
}

// ------------------------ small utils ------------------------
function onlyDigits(s = '') {
  return String(s || '').replace(/\D+/g, '');
}
function toE164US(phone) {
  const trimmed = (phone || '').trim();
  if (/^\+/.test(trimmed)) return trimmed;
  const digits = onlyDigits(trimmed);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed.startsWith('+') ? trimmed : `+${digits}`;
}

// ------------------------ Customers ------------------------
async function searchCustomersAll({ email, phone, text }) {
  const out = [];

  if (email) {
    let cursor;
    do {
      const body = {
        limit: 100,
        cursor,
        query: { filter: { email_address: { exact: String(email).trim() } } }
      };
      const res = await sqFetch('/v2/customers/search', { method: 'POST', body });
      out.push(...(res.customers || []));
      cursor = res.cursor || null;
    } while (cursor);
    if (out.length) return out;
  }

  if (phone) {
    let cursor;
    const e164 = toE164US(phone);
    do {
      const body = {
        limit: 100,
        cursor,
        query: { filter: { phone_number: { exact: e164 } } }
      };
      const res = await sqFetch('/v2/customers/search', { method: 'POST', body });
      out.push(...(res.customers || []));
      cursor = res.cursor || null;
    } while (cursor);
    if (out.length) return out;
  }

  if (text) {
    let cursor;
    do {
      const body = { limit: 100, cursor, query: { text_filter: String(text).trim() } };
      const res = await sqFetch('/v2/customers/search', { method: 'POST', body });
      out.push(...(res.customers || []));
      cursor = res.cursor || null;
    } while (cursor);
  }

  return out;
}

export async function findCustomer({ phone, email, givenName, familyName }) {
  const text =
    (givenName && familyName) ? `${givenName} ${familyName}` :
    (givenName || familyName) ? (givenName || familyName) :
    null;

  const customers = await searchCustomersAll({ email, phone, text });
  if (!customers.length) return null;

  if (email) {
    const exactEmail = customers.find(
      c => c.email_address && c.email_address.toLowerCase() === String(email).trim().toLowerCase()
    );
    if (exactEmail) return exactEmail;
  }
  if (phone) {
    const e164 = toE164US(phone);
    const exactPhone = customers.find(c => c.phone_number && c.phone_number === e164);
    if (exactPhone) return exactPhone;
  }

  customers.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  return customers[0];
}

export async function ensureCustomerByPhoneOrEmail({ givenName, phone, email }) {
  const existing = await findCustomer({ phone, email, givenName });
  if (existing) return existing;

  const body = {
    given_name: givenName || 'Caller',
    ...(email ? { email_address: String(email).trim() } : {}),
    ...(phone ? { phone_number: toE164US(phone) } : {})
  };
  const { customer } = await sqFetch('/v2/customers', { method: 'POST', body });
  return customer || null;
}

export async function resolveCustomerIds({ phone, email, givenName, familyName }) {
  try {
    const c = await findCustomer({ phone, email, givenName, familyName });
    return c ? [c.id] : [];
  } catch {
    return [];
  }
}

// ------------------------ Bookings ------------------------
async function searchBookingsByCustomerIds({ customerIds, locationId, teamMemberId, startAtMin, startAtMax }) {
  const all = [];
  for (const customerId of customerIds) {
    let cursor;
    do {
      const filter = {
        customer_id: customerId,
        start_at_range: { start_at: startAtMin, end_at: startAtMax }
      };
      if (locationId) filter.location_id = locationId;
      if (teamMemberId) filter.team_member_id = teamMemberId;

      const body = { limit: 100, cursor, query: { filter, sort: { sort_field: 'START_AT', order: 'ASC' } } };
      const res = await sqFetch('/v2/bookings/search', { method: 'POST', body });
      all.push(...(res.bookings || []));
      cursor = res.cursor || null;
    } while (cursor);
  }
  return all;
}

export async function lookupUpcomingBookingsByPhoneOrEmail({
  phone, email, givenName, familyName, locationId, teamMemberId, includePast = false
}) {
  const primary = await findCustomer({ phone, email, givenName, familyName });
  if (!primary) return { customer: null, bookings: [] };

  const now = new Date();
  const min = new Date(now);
  if (includePast) min.setDate(min.getDate() - 31);
  const max = new Date(min);
  max.setDate(max.getDate() + 31);
  const startAtMin = min.toISOString();
  const startAtMax = max.toISOString();

  const bookings = await searchBookingsByCustomerIds({
    customerIds: [primary.id], locationId, teamMemberId, startAtMin, startAtMax
  });

  return { customer: primary, bookings };
}

export { toE164US };
