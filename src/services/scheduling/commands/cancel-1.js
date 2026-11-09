/* Source-exact AppointmentService extraction. Preserve order and outcome contracts. */
export function createAppointmentcancel1Methods(deps) {
  const { assertConfirmationNotPending, InterventionService, SchedulingProviderFactory, SocketService, assertTransition, cancelAppointmentNotifications, ensureCancellationSideEffects, getAppointmentForBusiness, lifecycleMarker, resolveApprovalReview, runNonBlockingAppointmentSideEffect, tryRepairAppointmentLifecycle } = deps;
  return {
async cancel({ business, appointmentId, reason = "", notifyCustomer = true }) {
    const appointment = await getAppointmentForBusiness(
      business._id,
      appointmentId,
    );
    assertConfirmationNotPending(appointment);

    // A retry after the durable local transition replays idempotent side
    // effects instead of silently skipping anything that previously failed.
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
    const provider = SchedulingProviderFactory.getProvider(
      business,
      appointment.provider || "internal",
    );

    try {
      // Provider cancellation is required to be idempotent. Google Calendar
      // already treats a missing (404) event as canceled.
      await provider.cancelAppointment({ appointment, reason });
    } catch (error) {
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
      appointment.rescheduleRequest.status = 'canceled';
      appointment.rescheduleRequest.alertPending = true;
    }
    appointment.status = "canceled";
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

    // If this save fails after the provider delete, the appointment remains
    // locally confirmed. Retrying the endpoint is safe because provider
    // cancellation is idempotent and will reach this save again.
    await appointment.save();
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
