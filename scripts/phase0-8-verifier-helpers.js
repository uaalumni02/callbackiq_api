const apiBase = String(
  process.env.CALLBACKIQ_API_BASE_URL || "http://localhost:3000/api",
).replace(/\/$/, "");
const token = process.env.CALLBACKIQ_AUTH_TOKEN;
const serviceOfferingId = process.env.CALLBACKIQ_SERVICE_OFFERING_ID;
const customerPhone = process.env.CALLBACKIQ_TEST_CUSTOMER_PHONE;
const postalCode = process.env.CALLBACKIQ_TEST_POSTAL_CODE || "30318";

const assertConfigured = () => {
  const missing = [];
  if (!token) missing.push("CALLBACKIQ_AUTH_TOKEN");
  if (!serviceOfferingId) missing.push("CALLBACKIQ_SERVICE_OFFERING_ID");
  if (!customerPhone) missing.push("CALLBACKIQ_TEST_CUSTOMER_PHONE");
  if (missing.length) {
    throw new Error(`Missing environment values: ${missing.join(", ")}`);
  }
};

const request = async (path, options = {}) => {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${options.method || "GET"} ${path} failed (${response.status}): ${
        payload.message || JSON.stringify(payload)
      }`,
    );
  }
  return payload.data ?? payload;
};

const dateKey = (value) => new Date(value).toISOString().slice(0, 10);

const getCandidateSlots = async () => {
  const startDate =
    process.env.CALLBACKIQ_TEST_START_DATE ||
    dateKey(Date.now() + 3 * 86_400_000);
  const endDate =
    process.env.CALLBACKIQ_TEST_END_DATE ||
    dateKey(Date.now() + 14 * 86_400_000);
  const query = new URLSearchParams({
    serviceOfferingId,
    startDate,
    endDate,
    postalCode,
  });
  const availability = await request(`/availability?${query}`);
  const slots = availability.slots || [];
  if (slots.length < 2) {
    throw new Error("At least two available slots are required for create and reschedule verification.");
  }
  return slots;
};

export {
  apiBase,
  assertConfigured,
  customerPhone,
  getCandidateSlots,
  postalCode,
  request,
  serviceOfferingId,
};
