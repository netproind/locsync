import fetch from "node-fetch";

const { ACUITY_USER_ID, ACUITY_API_KEY } = process.env;
const ACUITY_BASE_URL = "https://acuityscheduling.com/api/v1";

export async function handleAcuityBooking(speechResult) {
  try {
    // Build correct Basic Auth header
    const authString = Buffer.from(`${ACUITY_USER_ID}:${ACUITY_API_KEY}`).toString("base64");

    const res = await fetch(`${ACUITY_BASE_URL}/appointment-types`, {
      headers: {
        Authorization: `Basic ${authString}`,
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Acuity API error ${res.status}: ${errorText}`);
    }

    const types = await res.json();
    console.log("📅 Available appointment types:", types);

    return `You said: ${speechResult}. I found ${types.length} appointment types in Acuity.`;
  } catch (err) {
    console.error("❌ Acuity error:", err);
    return "Sorry, I had trouble connecting to the booking system.";
  }
}
