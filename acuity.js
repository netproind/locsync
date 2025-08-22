import fetch from "node-fetch";

const ACUITY_BASE = "https://acuityscheduling.com/api/v1";
const USER_ID = process.env.ACUITY_USER_ID;
const API_KEY = process.env.ACUITY_API_KEY;

async function acuityRequest(endpoint, method = "GET", body = null) {
  const url = `${ACUITY_BASE}${endpoint}`;
  const opts = {
    method,
    headers: {
      "Authorization": "Basic " + Buffer.from(`${USER_ID}:${API_KEY}`).toString("base64"),
      "Content-Type": "application/json"
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Acuity error ${res.status}`);
  return await res.json();
}

export async function getAppointments() {
  return await acuityRequest("/appointments");
}

export async function createAppointment(details) {
  return await acuityRequest("/appointments", "POST", details);
}

export async function cancelAppointment(id) {
  return await acuityRequest(`/appointments/${id}/cancel`, "PUT");
}
