import fetch from "node-fetch";

const ACUITY_API_KEY = process.env.ACUITY_API_KEY;
const ACUITY_BASE_URL = "https://acuityscheduling.com/api/v1";

// 🔹 List appointments
export async function getAppointments() {
  const res = await fetch(`${ACUITY_BASE_URL}/appointments`, {
    headers: { Authorization: `Bearer ${ACUITY_API_KEY}` }
  });
  return res.json();
}

// 🔹 Create appointment
export async function createAppointment(data) {
  const res = await fetch(`${ACUITY_BASE_URL}/appointments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACUITY_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  });
  return res.json();
}

// 🔹 Cancel appointment
export async function cancelAppointment(id) {
  const res = await fetch(`${ACUITY_BASE_URL}/appointments/${id}/cancel`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${ACUITY_API_KEY}` }
  });
  return res.json();
}
