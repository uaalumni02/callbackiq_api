/* Source-exact AppointmentService extraction. Preserve order and outcome contracts. */
export function createAppointmentconfirm1Methods(deps) {
  const { Conversation, InterventionService, Lead, SchedulingProviderFactory, ServiceOffering, SocketService, assertDistributedLeaseActive, assertServiceRequestEligible, assertTransition, ensureBusinessApprovalNotice, exactSlotAvailable, getAppointmentForBusiness, lifecycleMarker, preservePendingApprovalOnAvailabilityConflict, projectionMarker, resolveApprovalReview, runNonBlockingAppointmentSideEffect, scheduleAppointmentReminders, tryRepairAppointmentLifecycle, tryRepairAppointmentProjections, safeConsole } = deps;
  // Once MongoDB has saved status=confirmed, these effects must not turn the booking into an HTTP failure.
  // Keep logs structured and tenant-scoped; the existing intervention is our durable human recovery record.
  const logCommittedEffectFailure = (effect, error, appointment, business) => {
    try {
      safeConsole.error('appointment.confirm.post_commit_effect_failed', {
        businessId: String(business?._id || ''),
        appointmentId: String(appointment?._id || ''),
        effect,
        error: String(error?.message || error).slice(0, 300),
      });
    } catch { /* Logging must not undo a committed booking. */ }
  };
  const safelyAfterCommit = async (effect, work, appointment, business) => {
    try { return await work(); }
    catch (error) { logCommittedEffectFailure(effect, error, appointment, business); return null; }
  };
  return {
async confirm({ business, appointmentId, approvedBy = null }) {
    const appointment = await getAppointmentForBusiness(
      business._id,
      appointmentId,
    );

    if (appointment.status === "confirmed") {
      await safelyAfterCommit("existing_lifecycle_repair", () => tryRepairAppointmentLifecycle(appointment, business), appointment, business);
      await safelyAfterCommit("existing_projection_repair", () => tryRepairAppointmentProjections(appointment), appointment, business);
      return appointment;
    }
    assertTransition(appointment.status, "confirmed");

    if (appointment.heldExpiresAt && appointment.heldExpiresAt <= new Date()) {
      appointment.status = "failed";
      appointment.activeSlotKey = null;
      appointment.slotClaimKeys = [];
      appointment.capacityLane = null;
      appointment.failureReason = "The appointment hold expired before confirmation.";
      appointment.approvalRecovery = { ...(appointment.approvalRecovery?.toObject?.() || appointment.approvalRecovery || {}), reconciled: false, expiredAt: new Date() };
      await appointment.save();
      const error = new Error("The appointment hold expired.");
      error.statusCode = 409;
      error.code = "HOLD_EXPIRED";
      throw error;
    }

    if (appointment.bookedBy === 'ai' || appointment.conversation) await assertServiceRequestEligible({ businessId: business._id,
      leadId: appointment.lead, conversationId: appointment.conversation, serviceOfferingId: appointment.serviceOffering,
      allowStaffReview: Boolean(approvedBy) });
    const stillAvailable = await exactSlotAvailable({
      business,
      serviceOfferingId: appointment.serviceOffering,
      startAt: appointment.startAt,
      endAt: appointment.endAt,
      postalCode: appointment.address?.postalCode,
      excludeAppointmentId: appointment._id,
      approvedExistingRequest: Boolean(approvedBy),
    });

    if (!stillAvailable) {
      if (preservePendingApprovalOnAvailabilityConflict(appointment)) {
        // Do not discard a still-open customer request merely because external
        // availability changed before staff approval. The hold remains visible
        // until normal maintenance expires it and reopens review for a new time.
        const error = new Error("That requested time is no longer available. The customer request remains open for staff review.");
        error.statusCode = 409;
        error.code = "SLOT_UNAVAILABLE";
        throw error;
      }
      appointment.status = "failed";
      appointment.activeSlotKey = null;
      appointment.slotClaimKeys = [];
      appointment.capacityLane = null;
      appointment.failureReason =
        "The slot was unavailable during the final availability check.";
      await appointment.save();
      const error = new Error("The selected appointment time is no longer available.");
      error.statusCode = 409;
      error.code = "SLOT_UNAVAILABLE";
      throw error;
    }

    const [service, lead] = await Promise.all([
      ServiceOffering.findById(appointment.serviceOffering),
      appointment.lead ? Lead.findById(appointment.lead) : null,
    ]);
    const provider = SchedulingProviderFactory.getProvider(business);
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

    await safelyAfterCommit("lifecycle_repair", () => tryRepairAppointmentLifecycle(appointment, business), appointment, business);
    await safelyAfterCommit("approval_review_repair", () => resolveApprovalReview(appointment), appointment, business);
    // Confirmation is durable at this point. Secondary notifications and
    // analytics must never roll the appointment back if they fail.
    if (appointment.requiresBusinessApproval || appointment.automaticConfirmationAuthorized) {
      await safelyAfterCommit("approval_confirmation_notice", () => runNonBlockingAppointmentSideEffect({
        appointment,
        businessId: business._id,
        label: "business approval customer confirmation",
        task: async () => {
          await ensureBusinessApprovalNotice({ appointment, business, service });
          if (appointment.conversation) {
            await Conversation.updateOne(
              { _id: appointment.conversation, business: business._id },
              {
                $set: {
                  "bookingState.status": "booked",
                  "bookingState.appointment": appointment._id,
                  "bookingState.expiresAt": null,
                  "bookingState.lastError": "",
                },
              },
            );
          }
        },
      }), appointment, business);
    }

    try {
      await scheduleAppointmentReminders({ appointment });
    } catch (error) {
      logCommittedEffectFailure("reminder_scheduling", error, appointment, business);
      await safelyAfterCommit("reminder_failure_intervention", () => InterventionService.create({
        businessId: business._id,
        leadId: appointment.lead,
        conversationId: appointment.conversation,
        appointmentId: appointment._id,
        type: "integration_failure",
        title: "Appointment reminders were not scheduled",
        message:
          "The appointment is confirmed, but CallBackIQ could not schedule its customer reminders.",
        priority: "medium",
        reason: error.message,
        recommendedAction:
          "Confirm reminder settings and contact the customer manually if needed.",
        metadata: { provider: appointment.provider || "internal" },
        dedupeKey: `appointment_reminder_schedule:${appointment._id}`,
      }), appointment, business);
    }

    await safelyAfterCommit("projection_repair", () => tryRepairAppointmentProjections(appointment), appointment, business);

    await safelyAfterCommit("business_socket_event", () => SocketService.emitToBusiness(
      business._id,
      "appointment:confirmed",
      appointment,
    ), appointment, business);
    await safelyAfterCommit("dashboard_socket_refresh", () => SocketService.emitDashboardRefresh(
      business._id,
      "appointment_confirmed",
    ), appointment, business);
    return appointment;
  }
  };
}
