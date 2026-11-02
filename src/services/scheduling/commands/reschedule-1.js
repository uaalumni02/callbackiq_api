/* Source-exact AppointmentService extraction. Preserve order and outcome contracts. */
export function createAppointmentreschedule1Methods(deps) {
  const { Appointment, InterventionService, Lead, SchedulingProviderFactory, SocketService, addMinutes, assertTransition, cancelAppointmentNotifications, createHold, crypto, exactSlotAvailable, getAppointmentForBusiness, getBookableService, lifecycleMarker, normalizeAddress, runNonBlockingAppointmentSideEffect, scheduleAppointmentReminders, tryRepairAppointmentLifecycle } = deps;
  return {
async reschedule({
    business,
    appointmentId,
    input,
    idempotencyKey,
  }) {
    if (input.address !== undefined) normalizeAddress(input.address);
    const original = await getAppointmentForBusiness(
      business._id,
      appointmentId,
    );
    if (input.requestId && (original.rescheduleRequest?.id !== input.requestId ||
        !['pending', 'approved'].includes(original.rescheduleRequest?.status) ||
        +new Date(original.rescheduleRequest.startAt) !== +new Date(input.startAt) ||
        +new Date(original.rescheduleRequest.endAt) !== +new Date(input.endAt))) {
      throw Object.assign(new Error('The customer request changed. Reload before approving.'), { statusCode: 409 });
    }
    const key = String(
      idempotencyKey ||
        input.idempotencyKey ||
        `reschedule:${original._id}:${crypto.randomUUID()}`,
    ).trim();

    let replacement = await Appointment.findOne({
      business: business._id,
      idempotencyKey: key,
    });

    if (
      replacement &&
      replacement.rescheduledFrom &&
      String(replacement.rescheduledFrom) !== String(original._id)
    ) {
      const error = new Error(
        "The idempotency key belongs to a different reschedule operation.",
      );
      error.statusCode = 409;
      error.code = "RESCHEDULE_IDEMPOTENCY_CONFLICT";
      throw error;
    }

    if (replacement && !replacement.rescheduledFrom && replacement.status === "held") {
      replacement.rescheduledFrom = original._id;
      await replacement.save();
    }

    const reconcileOriginal = async () => {
      if (original.status === "rescheduled") return;
      assertTransition(original.status, "rescheduled");
      if (original.rescheduleRequest?.status === 'pending') {
        original.rescheduleRequest.status = 'approved';
        original.rescheduleRequest.decidedAt = new Date();
        original.rescheduleRequest.alertPending = true;
      }
      original.status = "rescheduled";
      original.rescheduledTo = replacement._id;
      original.activeSlotKey = null;
      original.slotClaimKeys = [];
      original.capacityLane = null;
      original.externalAppointmentId = null;
      original.externalCalendarId = null;
      await original.save();
    };

    if (replacement?.status === "confirmed") {
      await reconcileOriginal();
      await tryRepairAppointmentLifecycle(replacement, business);
      return replacement;
    }

    if (replacement && replacement.status !== "held") {
      const error = new Error(
        `The prior reschedule operation cannot be replayed from state "${replacement.status}".`,
      );
      error.statusCode = 409;
      error.code = "RESCHEDULE_IDEMPOTENCY_FINAL_STATE";
      throw error;
    }

    if (original.status === "rescheduled") {
      if (original.rescheduledTo) {
        const existingReplacement = await Appointment.findOne({
          _id: original.rescheduledTo,
          business: business._id,
        });
        if (existingReplacement) { await tryRepairAppointmentLifecycle(existingReplacement, business); return existingReplacement; }
      }
      const error = new Error(
        "The appointment was already rescheduled but its replacement could not be resolved.",
      );
      error.statusCode = 409;
      error.code = "RESCHEDULE_REPLACEMENT_NOT_FOUND";
      throw error;
    }

    assertTransition(original.status, "rescheduled");

    const service = await getBookableService({
      businessId: business._id,
      serviceOfferingId: original.serviceOffering,
    });
    const nextInput = {
      ...input,
      serviceOfferingId: service._id,
      lead: original.lead,
      conversation: original.conversation,
      customerName: input.customerName || original.customerName,
      customerPhone: input.customerPhone || original.customerPhone,
      customerEmail: input.customerEmail || original.customerEmail,
      address: input.address || original.address,
      timezone: input.timezone || original.timezone,
      source: input.source || original.source,
      bookedBy: input.bookedBy || original.bookedBy,
      estimatedValue: original.estimatedValue,
      notes: input.notes || original.notes,
    };

    if (!replacement) {
      const available = await exactSlotAvailable({
        business,
        serviceOfferingId: service._id,
        startAt: nextInput.startAt,
        endAt:
          nextInput.endAt ||
          addMinutes(nextInput.startAt, service.durationMinutes),
        postalCode: nextInput.address?.postalCode,
        excludeAppointmentId: original._id,
      });

      if (!available) {
        const error = new Error(
          "The requested replacement time is unavailable.",
        );
        error.statusCode = 409;
        error.code = "SLOT_UNAVAILABLE";
        throw error;
      }

      replacement = await createHold({
        business,
        service,
        input: nextInput,
        preservedValuation: { estimatedValue: original.estimatedValue, valuation: original.valuation || { source: "legacy_unverified" } },
        idempotencyKey: key,
        excludeAppointmentId: original._id,
      });
      replacement.rescheduledFrom = original._id;
      await replacement.save();
    }

    const originalProviderName = original.provider || "internal";
    const provider = SchedulingProviderFactory.getProvider(
      business,
      originalProviderName,
    );

    /*
     * Provider-event ownership handoff
     * --------------------------------
     * A provider reschedule normally updates the SAME external calendar
     * event. The Appointment collection enforces a unique
     * (provider, externalAppointmentId) constraint, so the replacement
     * cannot claim that event while the original still owns it.
     *
     * The handoff is therefore staged durably:
     *
     *   1. Provider update succeeds.
     *   2. Provider IDs are persisted on non-unique pending fields.
     *   3. Original releases its unique provider linkage.
     *   4. Replacement claims the provider linkage and is confirmed.
     *   5. Original is finalized as rescheduled.
     *
     * If the process dies after step 3, a same-key replay recognizes the
     * staged provider ID and resumes locally without issuing a second
     * provider mutation.
     */
    const resumeProviderHandoff =
      replacement.status === "held" &&
      !original.externalAppointmentId &&
      Boolean(replacement.pendingRescheduleExternalAppointmentId);

    const replacementStateBeforeProvider = {
      status: replacement.status,
      confirmedAt: replacement.confirmedAt,
      heldExpiresAt: replacement.heldExpiresAt,
      externalAppointmentId: replacement.externalAppointmentId,
      externalCalendarId: replacement.externalCalendarId,
    };

    let stagedExternalAppointmentId =
      replacement.pendingRescheduleExternalAppointmentId || null;
    let stagedExternalCalendarId =
      replacement.pendingRescheduleExternalCalendarId || null;
    let providerApplied = resumeProviderHandoff;

    try {
      let providerResult;

      if (resumeProviderHandoff) {
        providerResult = {
          provider:
            replacement.provider || originalProviderName || "internal",
          externalAppointmentId: stagedExternalAppointmentId,
          externalCalendarId: stagedExternalCalendarId,
        };
      } else {
        // Provider PATCH is deliberately safe to replay with the same target
        // time. This closes the "provider succeeded / HTTP response was lost"
        // window.
        providerResult = await provider.updateAppointment({
          appointment: original,
          eventAppointment: replacement,
          changes: {
            startAt: replacement.startAt,
            endAt: replacement.endAt,
          },
          service,
        });
        providerApplied = true;

        stagedExternalAppointmentId =
          providerResult?.externalAppointmentId ||
          stagedExternalAppointmentId ||
          replacement.externalAppointmentId ||
          original.externalAppointmentId ||
          null;

        stagedExternalCalendarId =
          providerResult?.externalCalendarId ||
          stagedExternalCalendarId ||
          replacement.externalCalendarId ||
          original.externalCalendarId ||
          null;

        replacement.provider =
          providerResult?.provider ||
          replacement.provider ||
          originalProviderName ||
          "internal";

        /*
         * Persist the provider identity BEFORE releasing the original's
         * unique provider linkage. This is the durable recovery marker.
         */
        replacement.pendingRescheduleExternalAppointmentId =
          stagedExternalAppointmentId;
        replacement.pendingRescheduleExternalCalendarId =
          stagedExternalCalendarId;
        replacement.failureReason = "";
        await replacement.save();

        /*
         * Release only the provider-event uniqueness here. Keep the original
         * confirmed and keep its slot lineage intact until the replacement
         * has successfully claimed the provider event.
         *
         * If execution stops here, the staged replacement has enough durable
         * state for an idempotent same-key retry to finish the handoff.
         */
        original.externalAppointmentId = null;
        original.externalCalendarId = null;
        await original.save();
      }

      replacement.lifecycleNotice = lifecycleMarker("rescheduled");
      replacement.status = "confirmed";
      replacement.confirmedAt = replacement.confirmedAt || new Date();
      replacement.heldExpiresAt = null;
      replacement.provider =
        providerResult?.provider ||
        replacement.provider ||
        originalProviderName ||
        "internal";
      replacement.externalAppointmentId =
        providerResult?.externalAppointmentId ||
        stagedExternalAppointmentId ||
        replacement.externalAppointmentId ||
        null;
      replacement.externalCalendarId =
        providerResult?.externalCalendarId ||
        stagedExternalCalendarId ||
        replacement.externalCalendarId ||
        null;
      replacement.pendingRescheduleExternalAppointmentId = null;
      replacement.pendingRescheduleExternalCalendarId = null;
      replacement.failureReason = "";

      // The original has already released the unique event ID, so this claim
      // cannot collide with the original appointment.
      await replacement.save();

      // Complete lineage and release the original slot only after the
      // replacement durably owns the provider event.
      await reconcileOriginal();
    } catch (error) {
      /*
       * Restore the replacement to a retryable held state in memory before
       * attempting the reconciliation write. This prevents an error after a
       * provider update from accidentally persisting a half-confirmed local
       * appointment.
       */
      replacement.status = replacementStateBeforeProvider.status;
      replacement.confirmedAt = replacementStateBeforeProvider.confirmedAt;
      replacement.heldExpiresAt = replacementStateBeforeProvider.heldExpiresAt;
      replacement.externalAppointmentId =
        replacementStateBeforeProvider.externalAppointmentId || null;
      replacement.externalCalendarId =
        replacementStateBeforeProvider.externalCalendarId || null;

      if (providerApplied) {
        replacement.pendingRescheduleExternalAppointmentId =
          stagedExternalAppointmentId;
        replacement.pendingRescheduleExternalCalendarId =
          stagedExternalCalendarId;
      }

      replacement.failureReason = providerApplied
        ? `Provider update applied; local reconciliation required: ${error.message}`
        : `Provider update failed or outcome is uncertain; same-key retry required: ${error.message}`;

      try {
        await replacement.save();
      } catch {
        // Operational intervention below remains the final fallback.
      }

      try {
        await InterventionService.create({
          businessId: business._id,
          leadId: replacement.lead,
          conversationId: replacement.conversation,
          appointmentId: replacement._id,
          type: "integration_failure",
          title: "Appointment reschedule requires reconciliation",
          message: providerApplied
            ? "The calendar provider accepted the new appointment time, but CallBackIQ could not finish all local reschedule writes."
            : "CallBackIQ could not conclusively determine the calendar provider outcome. The replacement slot remains held to prevent a conflicting booking.",
          priority: "high",
          reason: error.message,
          recommendedAction:
            "Retry the exact same reschedule operation before making another calendar change.",
          metadata: {
            provider: originalProviderName,
            providerApplied,
            providerHandoffStaged: Boolean(stagedExternalAppointmentId),
            originalAppointmentId: String(original._id),
            replacementAppointmentId: String(replacement._id),
            idempotencyKey: key,
          },
          dedupeKey: `reschedule_reconciliation:${original._id}:${key}`,
        });
      } catch {
        // The original error remains authoritative.
      }

      error.statusCode = error.statusCode || 503;
      error.code = providerApplied
        ? "RESCHEDULE_RECONCILIATION_REQUIRED"
        : "RESCHEDULE_PROVIDER_OUTCOME_UNCERTAIN";
      error.safeCustomerMessage =
        "I couldn't safely finalize that calendar change. The requested replacement time is being protected while CallBackIQ reconciles the provider outcome.";

      try {
        await InterventionService.integrationFailure({
          businessId: business._id,
          leadId: replacement.lead,
          conversationId: replacement.conversation,
          appointmentId: replacement._id,
          provider: originalProviderName,
          error,
        });
      } catch {
        // Never mask the reschedule failure with an alerting failure.
      }

      throw error;
    }

    await tryRepairAppointmentLifecycle(replacement, business);
    await runNonBlockingAppointmentSideEffect({
      appointment: original,
      businessId: business._id,
      label: "reschedule reminder cleanup",
      task: () =>
        cancelAppointmentNotifications({
          businessId: business._id,
          appointmentId: original._id,
          reason: "Appointment rescheduled.",
        }),
    });

    await runNonBlockingAppointmentSideEffect({
      appointment: replacement,
      businessId: business._id,
      label: "rescheduled appointment reminder scheduling",
      task: () => scheduleAppointmentReminders({ appointment: replacement }),
    });

    if (replacement.lead) {
      await runNonBlockingAppointmentSideEffect({
        appointment: replacement,
        businessId: business._id,
        label: "rescheduled lead linkage",
        task: () =>
          Lead.updateOne(
            { _id: replacement.lead, business: business._id },
            {
              $set: {
                appointment: replacement._id,
                bookedAt: replacement.confirmedAt,
              },
            },
          ),
      });
    }

    SocketService.emitToBusiness(
      business._id,
      "appointment:rescheduled",
      { original, replacement },
    );
    SocketService.emitDashboardRefresh(
      business._id,
      "appointment_rescheduled",
    );
    return replacement;
  }
  };
}
