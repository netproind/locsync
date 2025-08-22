import axios from "axios";

const { ACUITY_API_KEY } = process.env;
const ACUITY_BASE_URL = "https://acuityscheduling.com/api/v1";

// Handle a booking or lookup in Acuity
export async function handleAcuityBooking(speechResult) {
  try {
    // Example: fetch list of appointment types
    const res = await axios.get(`${ACUITY_BASE_URL}/appointment-types`, {
      auth: {
        username: ACUITY_API_KEY, // Acuity requires API key as username
        password: "X"             // Password must literally be "X"
      }
    });

    const types = res.data || [];
    console.log("📅 Available appointment types:", types);

    // Just confirm we heard the caller for now
    return `You said: ${speechResult}. I found ${types.length} appointment types in Acuity.`;
  } catch (err) {
    console.error("❌ Acuity error:", err.response?.data || err.message);
    return "Sorry, I had trouble connecting to the booking system.";
  }
}
