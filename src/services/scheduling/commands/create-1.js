/* Source-exact AppointmentService extraction. Preserve order and outcome contracts. */
export function createAppointmentcreate1Methods(deps) {
  const { Appointment, SocketService, assertServiceRequestEligible, businessCalendarProviderName, createHold, crypto, getAiBookableService, getBookableService, moneyAmount, normalizeAddress, tryRepairAppointmentLifecycle, tryRepairAppointmentProjections } = deps;
  return {
async create({ business, input, idempotencyKey, confirm = true, ownerValuationAuthorized = false, intakeReviewVersion }) {
    if (input.address !== undefined) normalizeAddress(input.address);
    if (ownerValuationAuthorized && Object.prototype.hasOwnProperty.call(input, "estimatedValue") && input.estimatedValue !== null && moneyAmount(input.estimatedValue) === null) {
      const error = new Error("Estimated value must be null or a non-negative number."); error.statusCode = 400; throw error;
    }
    if (!input.customerPhone) {
      const error = new Error("customerPhone is required.");
      error.statusCode = 400;
      throw error;
    }

    const key = String(
      idempotencyKey || input.idempotencyKey || crypto.randomUUID(),
    ).trim();
    const existing = await Appointment.findOne({
      business: business._id,
      idempotencyKey: key,
    });
    if (existing) {
      if (existing.status === "confirmed") { await tryRepairAppointmentLifecycle(existing, business); await tryRepairAppointmentProjections(existing); return existing; }

      if (existing.status === "held") {
        if (existing.requiresBusinessApproval === true || !confirm) {
          return existing;
        }
        return this.confirm({
          business,
          appointmentId: existing._id,
        });
      }

      const error = new Error(
        `The prior appointment operation already finished in state "${existing.status}". Re-check availability before trying again.`,
      );
      error.statusCode = 409;
      error.code = "APPOINTMENT_IDEMPOTENCY_REPLAY_FINAL_STATE";
      error.existingStatus = existing.status;
      throw error;
    }

    const serviceResolver =
      input.bookedBy === "ai" ? getAiBookableService : getBookableService;
    const service = await serviceResolver({
      businessId: business._id,
      serviceOfferingId: input.serviceOfferingId || input.serviceOffering,
    });
    if (input.bookedBy === 'ai' || input.conversation || input.lead) await assertServiceRequestEligible({ businessId: business._id,
      leadId: input.lead, conversationId: input.conversation, serviceOfferingId: service._id,
      request: input.serviceQuery, allowStaffReview: input.bookedBy !== 'ai' });
    const hold = await createHold({
      business,
      service,
      input,
      ownerValuationAuthorized,
      idempotencyKey: key,
      intakeReviewVersion,
      // Immediate Google confirmations perform one external availability check
      // at confirm time. The internal claim index still protects the hold.
      checkExternalAvailability:
        !confirm || businessCalendarProviderName(business) !== "google_calendar",
    });

    if (!confirm || hold.status !== "held") {
      if (hold.requiresBusinessApproval) {
        SocketService.emitToBusiness(
          business._id,
          "appointment:approval_requested",
          hold,
        );
        SocketService.emitDashboardRefresh(
          business._id,
          "appointment_approval_requested",
        );
      }
      return hold;
    }

    return this.confirm({ business, appointmentId: hold._id });
  }
  };
}
