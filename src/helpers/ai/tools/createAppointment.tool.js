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

  // Automatic commitment requires explicit owner authorization and an eligible
  // service. Existing policies remain manual until the owner opts in again.
  const automaticConfirmationAuthorized = policy.aiBookingConfirmationMode === 'auto' &&
    policy.automaticConfirmationAuthorized === true && service?.requiresHumanReview !== true && business.features?.aiBookingEnabled === true;
  const requiresBusinessApproval = !automaticConfirmationAuthorized;
  const holdMinutes = Number(policy.manualApprovalHoldMinutes || 30);

  const appointment = await AppointmentService.create({
    business,
    input: {
      ...input,
      source: input?.source || "sms",
      bookedBy: "ai",
      requiresBusinessApproval,
      automaticConfirmationAuthorized,
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
    confirm: automaticConfirmationAuthorized,
  });

  if (
    appointment?.status === "held" &&
    appointment?.requiresBusinessApproval === true
  ) {
    await AlertService.createSystemAlert({
      businessId: business._id,
      title: "Appointment approval required",
      actionRequired: true,
      assignedTo: business.owner || null,
      leadId: input?.lead || null,
      conversationId: input?.conversation || null,
      appointmentId: appointment._id,
      dueAt: appointment.heldExpiresAt ? new Date(Math.min(new Date(appointment.heldExpiresAt).getTime(), Date.now() + 15 * 60000)) : null,
      message:
        "A customer selected a real available time. Review and approve the held appointment before the customer is told it is confirmed.",
      priority:
        ["high", "emergency"].includes(String(input?.urgency || ""))
          ? "high"
          : "medium",
      metadata: {
        approvalRequest: true,
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
