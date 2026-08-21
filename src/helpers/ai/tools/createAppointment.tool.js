import AppointmentService from "../../../services/scheduling/appointment.service.js";
import {
  getBookableService,
  getSchedulingPolicy,
} from "../../../services/scheduling/appointmentPolicy.service.js";

export const createAppointmentTool = async ({
  business,
  input,
  idempotencyKey,
}) => {
  const [policy, service] = await Promise.all([
    getSchedulingPolicy(business._id),
    getBookableService({
      businessId: business._id,
      serviceOfferingId: input?.serviceOfferingId || input?.serviceOffering,
    }),
  ]);
  const requiresBusinessApproval =
    service.requiresHumanReview === true ||
    policy.aiBookingConfirmationMode === "manual";

  return AppointmentService.create({
    business,
    input: {
      ...input,
      // Preserve the channel supplied by the shared booking state machine.
      // SMS remains the backward-compatible default for older callers.
      source: input?.source || "sms",
      bookedBy: "ai",
      requiresBusinessApproval,
      holdMinutes: requiresBusinessApproval
        ? Number(policy.manualApprovalHoldMinutes || 30)
        : input?.holdMinutes,
    },
    idempotencyKey,
    confirm: !requiresBusinessApproval,
  });
};

export default createAppointmentTool;
