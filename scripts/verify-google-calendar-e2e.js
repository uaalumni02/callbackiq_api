import crypto from "crypto";
import {
  assertConfigured,
  customerPhone,
  getCandidateSlots,
  postalCode,
  request,
  serviceOfferingId,
} from "./phase0-8-verifier-helpers.js";

const run = async () => {
  assertConfigured();
  const status = await request("/integrations/google/status");
  if (status.status !== "connected" || !status.providerCalendarId) {
    throw new Error("Connect Google Calendar and select a writable booking calendar first.");
  }

  await request("/integrations/google/test", {
    method: "POST",
    body: "{}",
  });

  const [first, second] = await getCandidateSlots();
  const appointment = await request("/appointments", {
    method: "POST",
    headers: { "Idempotency-Key": `phase3-${crypto.randomUUID()}` },
    body: JSON.stringify({
      serviceOfferingId,
      customerName: "Google Calendar Verification",
      customerPhone,
      address: { postalCode },
      startAt: first.startAt,
      endAt: first.endAt,
      source: "manual",
      bookedBy: "staff",
    }),
  });

  if (
    appointment.status !== "confirmed" ||
    appointment.provider !== "google_calendar" ||
    !appointment.externalAppointmentId
  ) {
    throw new Error("The appointment was not confirmed and linked to a Google event.");
  }

  const replacement = await request(`/appointments/${appointment._id}/reschedule`, {
    method: "POST",
    headers: { "Idempotency-Key": `phase3-reschedule-${crypto.randomUUID()}` },
    body: JSON.stringify({ startAt: second.startAt, endAt: second.endAt }),
  });

  if (
    replacement.status !== "confirmed" ||
    replacement.provider !== "google_calendar" ||
    !replacement.externalAppointmentId
  ) {
    throw new Error("The replacement appointment was not linked to Google Calendar.");
  }

  const canceled = await request(`/appointments/${replacement._id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "Automated Phase 3 completion-gate verification" }),
  });

  if (canceled.status !== "canceled") {
    throw new Error("Google Calendar cancellation verification failed.");
  }

  console.log("Phase 3 Google Calendar completion gate passed.");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
