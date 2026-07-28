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
  const status = await request("/integrations/jobber/status");
  if (status.status !== "connected") {
    throw new Error("Connect a Jobber development account first.");
  }

  await request("/integrations/jobber/test", {
    method: "POST",
    body: "{}",
  });

  const [first, second] = await getCandidateSlots();
  const appointment = await request("/appointments", {
    method: "POST",
    headers: { "Idempotency-Key": `phase8-${crypto.randomUUID()}` },
    body: JSON.stringify({
      serviceOfferingId,
      customerName: "Jobber Verification",
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
    appointment.provider !== "jobber" ||
    !appointment.externalAppointmentId
  ) {
    throw new Error("The appointment was not confirmed and linked to a Jobber record.");
  }

  const replacement = await request(`/appointments/${appointment._id}/reschedule`, {
    method: "POST",
    headers: { "Idempotency-Key": `phase8-reschedule-${crypto.randomUUID()}` },
    body: JSON.stringify({ startAt: second.startAt, endAt: second.endAt }),
  });

  if (
    replacement.status !== "confirmed" ||
    replacement.provider !== "jobber" ||
    !replacement.externalAppointmentId
  ) {
    throw new Error("The Jobber reschedule verification failed.");
  }

  const canceled = await request(`/appointments/${replacement._id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "Automated Phase 8 completion-gate verification" }),
  });

  if (canceled.status !== "canceled") {
    throw new Error("The Jobber cancellation verification failed.");
  }

  console.log("Phase 8 Jobber completion gate passed.");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
