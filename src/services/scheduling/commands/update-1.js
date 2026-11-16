import { stageStaffAppointmentOutcome } from '../../stateTransitions/appointmentCommands.js';
import { saveStateDocument } from '../../stateTransitions/documents.js';
/* Source-exact AppointmentService extraction. Preserve order and outcome contracts. */
export function createAppointmentupdate1Methods(deps) {
  const { assertConfirmationNotPending, ServiceOffering, SocketService, assertTransition, getAppointmentForBusiness, moneyAmount, normalizeAddress, ownerEstimate, projectionMarker, resolveOpportunityValue, tryRepairAppointmentProjections } = deps;
  return {
async update({ businessId, appointmentId, changes }) {
    if (changes.address !== undefined) normalizeAddress(changes.address);
    const appointment = await getAppointmentForBusiness(
      businessId,
      appointmentId,
    );
    assertConfirmationNotPending(appointment);
    if (Object.prototype.hasOwnProperty.call(changes, "estimatedValue") && changes.estimatedValue !== null && moneyAmount(changes.estimatedValue) === null) {
      const error = new Error("Estimated value must be null or a non-negative number."); error.statusCode = 400; throw error;
    }
    if (changes.valuationAction && changes.valuationAction !== "automatic") {
      const error = new Error("Invalid valuation action."); error.statusCode = 400; throw error;
    }
    if (changes.valuationAction === "automatic") {
      const services = await ServiceOffering.find({ business: businessId, active: true, _id: appointment.serviceOffering?._id || appointment.serviceOffering }).lean();
      Object.assign(appointment, resolveOpportunityValue({ businessId, services, selectedServiceId: appointment.serviceOffering?._id || appointment.serviceOffering }));
      appointment.valuationVersion = (appointment.valuationVersion || 0) + 1;
    } else if (Object.prototype.hasOwnProperty.call(changes, "estimatedValue")) {
      Object.assign(appointment, ownerEstimate(changes.estimatedValue));
      appointment.valuationVersion = (appointment.valuationVersion || 0) + 1;
    }
    const allowed = [
      "customerName",
      "customerPhone",
      "customerEmail",
      "address",
      "notes",
      "actualRevenue",
    ];
    for (const field of allowed) {
      if (Object.prototype.hasOwnProperty.call(changes, field)) {
        appointment[field] =
          field === "address"
            ? normalizeAddress(changes[field])
            : changes[field];
      }
    }
    if (changes.status && changes.status !== appointment.status) {
      assertTransition(appointment.status, changes.status);
      if (!["completed", "no_show"].includes(changes.status)) {
        const error = new Error(
          "Use the dedicated confirm, cancel, or reschedule endpoint.",
        );
        error.statusCode = 400;
        throw error;
      }
      stageStaffAppointmentOutcome({ appointment, changes });
      appointment.activeSlotKey = null;
      appointment.slotClaimKeys = [];
      appointment.capacityLane = null;
      if (changes.status === "completed") appointment.completedAt = new Date();
      if (changes.status === "no_show") appointment.noShowAt = new Date();
    }

    if (appointment.status === "completed") appointment.completionProjection = projectionMarker();
    await saveStateDocument(appointment);
    // Saved completion is success even when secondary work needs a retry.
    await tryRepairAppointmentProjections(appointment);


    // CALLBACKIQ_AUTHORITATIVE_OWNER_OUTCOME_V1
    SocketService.emitToBusiness(
      businessId,
      "appointment:updated",
      appointment,
    );
    SocketService.emitDashboardRefresh(
      businessId,
      appointment.status === "completed"
        ? "appointment_completed"
        : appointment.status === "no_show"
          ? "appointment_no_show"
          : "appointment_updated",
    );

    return appointment;
  }
  };
}
