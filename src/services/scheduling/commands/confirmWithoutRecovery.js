export async function confirmWithoutRecovery(
  { appointment, business, approvedBy, provider, service },
  { assertDistributedLeaseActive, InterventionService, lifecycleMarker, projectionMarker },
) {
  let providerResult = null;

  try {
    assertDistributedLeaseActive();
    providerResult = await provider.createAppointment({
      appointment,
      service,
    });
    appointment.provider = providerResult.provider || appointment.provider;
    appointment.externalAppointmentId =
      providerResult.externalAppointmentId || null;
    appointment.externalCalendarId =
      providerResult.externalCalendarId || null;
    appointment.status = "confirmed";
    appointment.bookingProjection = projectionMarker();
    if (!appointment.requiresBusinessApproval && !appointment.automaticConfirmationAuthorized && appointment.bookedBy !== "ai") appointment.lifecycleNotice = lifecycleMarker("confirmed");
    appointment.approvalRecovery = { state: "resolved", reconciled: false };
    appointment.confirmedAt = new Date();
    appointment.heldExpiresAt = null;
    appointment.failureReason = "";
    if (appointment.requiresBusinessApproval) {
      appointment.approvalDecisionAt = new Date();
      appointment.approvalDecisionBy = approvedBy || null;
      appointment.approvalDeclineReason = "";
    }
    await appointment.save();
  } catch (error) {
    // If Google accepted the insert but MongoDB did not persist confirmation,
    // remove the event immediately so the business does not inherit an orphan.
    if (providerResult?.externalAppointmentId) {
      try {
        await provider.cancelAppointment({
          appointment: {
            ...appointment.toObject(),
            externalAppointmentId: providerResult.externalAppointmentId,
            externalCalendarId: providerResult.externalCalendarId,
          },
          reason: "CallBackIQ rolled back an incomplete confirmation.",
        });
      } catch (cleanupError) {
        await InterventionService.create({
          businessId: business._id,
          leadId: appointment.lead,
          conversationId: appointment.conversation,
          appointmentId: appointment._id,
          type: "integration_failure",
          title: "Google Calendar event needs cleanup",
          message:
            "Google created an event, but CallBackIQ could not persist the matching appointment or remove the event automatically.",
          priority: "high",
          reason: cleanupError.message,
          recommendedAction:
            "Remove the orphaned Google event and retry the customer booking.",
          metadata: {
            provider: "google_calendar",
            googleEventId: providerResult.externalAppointmentId,
            googleCalendarId: providerResult.externalCalendarId,
          },
          dedupeKey: `google_orphan_cleanup:${appointment._id}:${providerResult.externalAppointmentId}`,
        });
      }
    }

    appointment.status = "failed";
    appointment.activeSlotKey = null;
    appointment.slotClaimKeys = [];
    appointment.capacityLane = null;
    appointment.heldExpiresAt = null;
    appointment.failureReason = error.message;
    try {
      await appointment.save();
    } catch {
      // Preserve the original provider/persistence error for the caller.
    }
    await InterventionService.integrationFailure({
      businessId: business._id,
      leadId: appointment.lead,
      conversationId: appointment.conversation,
      appointmentId: appointment._id,
      provider: appointment.provider || "internal",
      error,
    });
    error.safeCustomerMessage =
      "I’m having trouble confirming that appointment right now. I’ve sent your request to the team so they can confirm it directly.";
    throw error;
  }
}
