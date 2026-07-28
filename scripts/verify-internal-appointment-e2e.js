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
  const [first, second] = await getCandidateSlots();
  const appointment = await request("/appointments", {
    method: "POST",
    headers: { "Idempotency-Key": `phase2-${crypto.randomUUID()}` },
    body: JSON.stringify({
      serviceOfferingId,
      customerName: "Phase 2 Verification",
      customerPhone,
      address: { postalCode },
      startAt: first.startAt,
      endAt: first.endAt,
      source: "manual",
      bookedBy: "staff",
    }),
  });

  if (appointment.status !== "confirmed") {
    throw new Error(`Expected confirmed appointment; received ${appointment.status}.`);
  }

  const replacement = await request(`/appointments/${appointment._id}/reschedule`, {
    method: "POST",
    headers: { "Idempotency-Key": `phase2-reschedule-${crypto.randomUUID()}` },
    body: JSON.stringify({ startAt: second.startAt, endAt: second.endAt }),
  });

  if (replacement.status !== "confirmed") {
    throw new Error(`Expected confirmed replacement; received ${replacement.status}.`);
  }

  const canceled = await request(`/appointments/${replacement._id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "Automated Phase 2 completion-gate verification" }),
  });

  if (canceled.status !== "canceled") {
    throw new Error(`Expected canceled replacement; received ${canceled.status}.`);
  }

  console.log("Phase 2 internal appointment completion gate passed.");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
