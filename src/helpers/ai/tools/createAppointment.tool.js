import { assertServiceRequestEligible } from '../../../services/serviceEligibility/serviceEligibility.service.js';
import AppointmentService from "../../../services/scheduling/appointment.service.js";
import AlertService from "../../../services/alert.service.js";
import {
  getAiBookableService,
  getSchedulingPolicy,
} from "../../../services/scheduling/appointmentPolicy.service.js";
import { logOperationalError } from "../../logging/safeLogger.js";

export const createAppointmentTool = async ({
  business,
  input,
  idempotencyKey,
}) => {
  await assertServiceRequestEligible({ businessId: business._id, leadId: input?.lead, conversationId: input?.conversation, serviceOfferingId: input?.serviceOfferingId || input?.serviceOffering, request: input?.serviceQuery });
  const [policy, service] = await Promise.all([
    getSchedulingPolicy(business._id),
    getAiBookableService({
      businessId: business._id,
      serviceOfferingId: input?.serviceOfferingId || input?.serviceOffering,
    }),
  ]);

  // Production invariant: AI may submit an appointment request, but only a
  // business approval can create the final customer commitment.
  const requiresBusinessApproval = true;
  const holdMinutes = Number(policy.manualApprovalHoldMinutes || 30);

  const appointment = await AppointmentService.create({
    business,
    input: {
      ...input,
      source: input?.source || "sms",
      bookedBy: "ai",
      requiresBusinessApproval,
      holdMinutes,
      notes: [
        String(input?.notes || "").trim(),
        service?.requiresHumanReview === true
          ? "Service requires human review."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    idempotencyKey,
    confirm: false,
  });

  if (
    appointment?.status === "held" &&
    appointment?.requiresBusinessApproval === true
  ) {
    await AlertService.createSystemAlert({
      businessId: business._id,
      title: "Appointment approval required",
      message:
        "A customer selected a real available time. Review and approve the held appointment before the customer is told it is confirmed.",
      priority:
        ["high", "emergency"].includes(String(input?.urgency || ""))
          ? "high"
          : "medium",
      metadata: {
        appointmentId: String(appointment._id),
        leadId: input?.lead ? String(input.lead) : "",
        conversationId: input?.conversation ? String(input.conversation) : "",
        source: input?.source || "sms",
        startAt: appointment.startAt || input?.startAt || null,
        heldExpiresAt: appointment.heldExpiresAt || null,
      },
      dedupeKey: `appointment_approval_required:${appointment._id}`,
    }).catch((error) => {
      logOperationalError("booking.approval_alert_failed", error, {
        businessId: business._id,
        appointmentId: appointment?._id,
      });
    });
  }

  return appointment;
};

export default createAppointmentTool;
