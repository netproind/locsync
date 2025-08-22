import fetch from "node-fetch";

const { ACUITY_API_KEY } = process.env;
const ACUITY_BASE_URL = "https://acuityscheduling.com/api/v1";

// Dummy booking handler for now
// Later you can map `speechResult` to a real service
export async function handleAcuityBooking(speechResult) {
  try {
    // Example: just fetch the list of appointment types
    const res = await fetch(`${ACUITY_BASE_URL}/appointment-types`, {
      headers: {
        Authorization: `Bearer ${ACUITY_API_KEY}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Acuity API error: ${res.status}`);
    }

    const types = await res.json();
    console.log("📅 Available appointment types:", types);

    // For now, just confirm we heard the caller
    return `You said: ${speechResult}. I found ${types.length} appointment types in Acuity.`;
  } catch (err) {
    console.error("❌ Acuity error:", err);
    return "Sorry, I had trouble connecting to the booking system.";
  }
}
