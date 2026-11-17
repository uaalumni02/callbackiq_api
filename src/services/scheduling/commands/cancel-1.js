import { stageCanceledRescheduleRequest, stageCanceledAppointment } from '../../stateTransitions/appointmentCommands.js';
import { saveStateDocument } from '../../stateTransitions/documents.js';
import { claimAppointmentCancellation, deferAppointmentCancellation } from '../../stateTransitions/appointmentOwnership.js';
export function createAppointmentcancel1Methods(deps) {
  const { Appointment, assertConfirmationNotPending, InterventionService, SchedulingProviderFactory, SocketService, assertTransition, cancelAppointmentNotifications, ensureCancellationSideEffects, getAppointmentForBusiness, lifecycleMarker, resolveApprovalReview, runNonBlockingAppointmentSideEffect, tryRepairAppointmentLifecycle } = deps;
  return {
async cancel({ business, appointmentId, reason = "", notifyCustomer = true }) {
    let appointment = await getAppointmentForBusiness(
      business._id,
      appointmentId,
    );
    assertConfirmationNotPending(appointment);
    if (appointment.status === "canceled") {
      await tryRepairAppointmentLifecycle(appointment, business);
      await resolveApprovalReview(appointment).catch(() => {});
      await runNonBlockingAppointmentSideEffect({
        appointment,
        businessId: business._id,
        label: "cancellation reminder cleanup",
        task: () =>
          cancelAppointmentNotifications({
            businessId: business._id,
            appointmentId: appointment._id,
            reason: "Appointment canceled.",
            types: ["reminder", "follow_up"],
          }),
      });
      await ensureCancellationSideEffects({
        business,
        appointment,
        reason,
      });
      return appointment;
    }
    assertTransition(appointment.status, "canceled");
    appointment = await claimAppointmentCancellation({ Appointment, appointment, reason, notifyCustomer });
    reason = appointment.cancellationIntent.reason;
    notifyCustomer = appointment.cancellationIntent.notifyCustomer;
    const provider = SchedulingProviderFactory.getProvider(
      business,
      appointment.provider || "internal",
    );
    try {
      // Provider cancellation must be idempotent; replay follows any uncertain result.
      await provider.cancelAppointment({ appointment, reason });
    } catch (error) {
      await deferAppointmentCancellation({ Appointment, appointment, error });
      await InterventionService.integrationFailure({
        businessId: business._id,
        leadId: appointment.lead,
        conversationId: appointment.conversation,
        appointmentId: appointment._id,
        provider: appointment.provider || "internal",
        error,
      });
      throw error;
    }
    if (notifyCustomer) appointment.lifecycleNotice = lifecycleMarker("canceled");
    if (appointment.rescheduleRequest?.status === 'pending') {
      stageCanceledRescheduleRequest({ appointment });
      appointment.rescheduleRequest.alertPending = true;
    }
    stageCanceledAppointment({ appointment });
    appointment.approvalRecovery = { state: "resolved", reconciled: false };
    appointment.canceledAt = appointment.canceledAt || new Date();
    appointment.activeSlotKey = null;
    appointment.slotClaimKeys = [];
    appointment.capacityLane = null;
    appointment.notes = [
      appointment.notes,
      reason ? `Cancellation: ${reason}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    // Keep the claimed version and lease token through the provider result.
    appointment.$where = { 'cancellationIntent.token': appointment.cancellationIntent.token };
    await saveStateDocument(appointment);
    await tryRepairAppointmentLifecycle(appointment, business);
    await resolveApprovalReview(appointment).catch(() => {});
    await runNonBlockingAppointmentSideEffect({
      appointment,
      businessId: business._id,
      label: "cancellation reminder cleanup",
      task: () =>
        cancelAppointmentNotifications({
          businessId: business._id,
          appointmentId: appointment._id,
          reason: "Appointment canceled.",
            types: ["reminder", "follow_up"],
        }),
    });
    await ensureCancellationSideEffects({
      business,
      appointment,
      reason,
    });
    SocketService.emitToBusiness(
      business._id,
      "appointment:canceled",
      appointment,
    );
    SocketService.emitDashboardRefresh(
      business._id,
      "appointment_canceled",
    );
    return appointment;
  }
  };
}
