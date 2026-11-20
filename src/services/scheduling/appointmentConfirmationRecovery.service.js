import BusinessModel from '../../models/business.js';
import { confirmationPending } from './appointmentConfirmationIntent.repository.js';

const retryDelay = (attempts) => Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempts, 5));

const rejection = (message) => Object.assign(new Error(message), { confirmationRejected: true });

const isDefiniteRejection = (error, provider, earlierAttempts) =>
  error.confirmationRejected || error.code === 'PROVIDER_NOT_CONFIGURED' || provider === 'internal' || (earlierAttempts === 0 && error.confirmationCreateRejected);

async function verifyExternalConfirmation({ appointment, provider, receipt }) {
    if (provider.capabilities?.confirmation === 'verify_external_record') {
      const observed = await provider.getAppointment({ appointment: { ...appointment.toObject(),
        externalAppointmentId: receipt.externalAppointmentId, externalCalendarId: receipt.externalCalendarId } });
      if (!observed?.id || String(observed.id) !== String(receipt.externalAppointmentId)) throw Object.assign(new Error('External appointment persistence is unverified'), { code: 'PROVIDER_CONFIRMATION_UNCERTAIN' });
      const start = observed.startAt || observed.start || observed.startsAt;
      const end = observed.endAt || observed.end || observed.endsAt;
      if (new Date(start).getTime() !== new Date(appointment.startAt).getTime() ||
          new Date(end).getTime() !== new Date(appointment.endAt).getTime() ||
          ['canceled', 'cancelled', 'deleted'].includes(String(observed.status || '').toLowerCase())) {
        throw Object.assign(new Error('External appointment time or status does not verify this booking'), { code: 'PROVIDER_CONFIRMATION_UNCERTAIN' });
      }
    }
}

export function createConfirmationRecovery({
  intent, InterventionService, Business = BusinessModel, ServiceOffering, SchedulingProviderFactory, safeConsole,
  exactSlotAvailable, assertServiceRequestEligible, assertIntakeHoldCurrent, assertDistributedLeaseActive, projectionMarker, lifecycleMarker,
  testCrash, clock = () => new Date(),
}) {
  const crash = (phase) => {
    if (process.env.NODE_ENV === 'test') testCrash?.(phase);
  };

  const report = async (appointment, error, cleanup = null) => {
    const context = {
      businessId: appointment.business, leadId: appointment.lead, conversationId: appointment.conversation,
      appointmentId: appointment._id, provider: appointment.confirmationIntent.provider, error,
    };
    try {
      if (cleanup) {
        await InterventionService.create({
          ...context,
          type: 'integration_failure', title: 'Calendar event needs confirmation cleanup',
          message: 'The provider created an event and automatic cleanup could not finish. The original confirmation intent is still being reconciled.',
          priority: 'high', reason: error.message,
          recommendedAction: 'Check the provider event and the pending confirmation before retrying this booking.',
          metadata: { provider: context.provider, externalAppointmentId: cleanup.eventId, externalCalendarId: cleanup.calendarId },
          dedupeKey: `appointment_confirmation_cleanup:${appointment._id}:${cleanup.eventId}`,
        });
      } else {
        await InterventionService.integrationFailure(context);
      }
      return true;
    } catch (reportError) {
      safeConsole.error('appointment.confirm.recovery_intervention_failed', {
        appointmentId: String(appointment._id), error: reportError.message,
      });
      return false;
    }
  };

  async function failed(appointment, error) {
    const saved = await intent.patch(appointment, {
      status: 'failed', activeSlotKey: null, slotClaimKeys: [], capacityLane: null, heldExpiresAt: null,
      failureReason: String(error.message).slice(0, 2000),
      'confirmationIntent.status': 'failed', 'confirmationIntent.effectsPending': true,
    });
    if (saved) await finishFailure(saved, error);
  }

  async function finishFailure(appointment, error) {
    if (await report(appointment, error)) await intent.finishEffects(appointment);
    else await intent.defer(appointment, retryDelay(appointment.confirmationIntent.attempts));
  }

  async function compensate(appointment, provider) {
    const { compensation, target } = appointment.confirmationIntent;
    try {
      await provider.cancelAppointment({
        appointment: { ...appointment.toObject(), externalAppointmentId: compensation.eventId, externalCalendarId: compensation.calendarId },
        target,
        reason: 'MeekCall rolled back an incomplete confirmation.',
      });
    } catch (error) {
      await report(appointment, error, compensation);
      await intent.defer(appointment, retryDelay(appointment.confirmationIntent.attempts));
      return;
    }
    await failed(appointment, new Error(compensation.error));
  }

  async function finalize(appointment, provider, receipt, recovering) {
    const { approvedBy } = appointment.confirmationIntent;
    const now = clock();
    const fields = {
      provider: receipt.provider || appointment.provider,
      externalAppointmentId: receipt.externalAppointmentId || null,
      externalCalendarId: receipt.externalCalendarId || null,
      status: 'confirmed', bookingProjection: projectionMarker(),
      approvalRecovery: { state: 'resolved', reconciled: false },
      confirmedAt: now, heldExpiresAt: null, failureReason: '',
      'confirmationIntent.status': 'confirmed', 'confirmationIntent.effectsPending': true,
      ...(appointment.requiresBusinessApproval ? {
        approvalDecisionAt: now, approvalDecisionBy: approvedBy || null, approvalDeclineReason: '',
      } : {}),
    };
    if (!appointment.requiresBusinessApproval && !appointment.automaticConfirmationAuthorized &&
        appointment.bookedBy !== 'ai' && (!recovering || appointment.startAt > now)) {
      fields.lifecycleNotice = lifecycleMarker('confirmed');
    }
    let saved;
    try {
      saved = await intent.patch(appointment, fields);
    } catch (error) {
      // A write error can be an acknowledgement failure. A majority read and a
      // fenced write must both rule out confirmation before cleanup can start.
      saved = await intent.getCommitted(appointment).catch(() => null);
      if (saved) return saved;
      try {
        if (receipt.externalAppointmentId) {
          const cleanup = await intent.patch(appointment, { 'confirmationIntent.compensation': {
            eventId: receipt.externalAppointmentId, calendarId: receipt.externalCalendarId,
            error: String(error.message).slice(0, 2000),
          } });
          if (cleanup) await compensate(cleanup, provider);
        } else {
          await failed(appointment, error);
        }
      } catch {
        // An unavailable database leaves the original intent for the reconciler.
        await report(appointment, error);
      }
      throw error;
    }
    if (!saved) throw confirmationPending();
    return saved;
  }

  async function lookupOrRetry({ appointment, business, provider }) {
    const { attempts, target } = appointment.confirmationIntent;
    if (attempts > 0 && provider.findConfirmation) {
      const receipt = await provider.findConfirmation({ appointment, target });
      if (receipt) return receipt;
    }
    if (attempts > 0 && provider.capabilities?.confirmation === 'verify_external_record') {
      throw Object.assign(new Error('An earlier provider mutation has an unverified outcome. Review its record before retrying.'), {
        code: 'PROVIDER_CONFIRMATION_UNCERTAIN',
      });
    }
    // An earlier HTTP request can still land after a missing-event lookup.
    // Keep its original intent recoverable when retry policy blocks a new insert.
    const stopRetry = (message) => attempts === 0 ? rejection(message) : new Error(message);
    if (appointment.startAt <= clock()) throw stopRetry('The requested time passed before provider confirmation could finish.');
    if (provider.assertConfirmationRetryTarget) await provider.assertConfirmationRetryTarget({ appointment, target });
    const approvedExistingRequest = Boolean(appointment.confirmationIntent.approvedBy);
    if (appointment.bookedBy === 'ai' || appointment.conversation) {
      await assertServiceRequestEligible({ businessId: business._id, leadId: appointment.lead,
        conversationId: appointment.conversation, serviceOfferingId: appointment.serviceOffering,
        allowStaffReview: approvedExistingRequest });
    }
    const available = await exactSlotAvailable({
      business, serviceOfferingId: appointment.serviceOffering, startAt: appointment.startAt, endAt: appointment.endAt,
      postalCode: appointment.address?.postalCode, excludeAppointmentId: appointment._id,
      approvedExistingRequest,
    });
    if (!available) throw stopRetry('The appointment slot became unavailable while recovering confirmation.');
    return null;
  }

  async function prepareTarget(appointment, provider) {
    if (!provider.prepareConfirmation || appointment.confirmationIntent.target?.eventId) return appointment;
    const target = await provider.prepareConfirmation({ appointment });
    const saved = await intent.patch(appointment, { 'confirmationIntent.target': target });
    if (!saved) throw confirmationPending();
    return saved;
  }

  async function handleProviderFailure(appointment, error, earlierAttempts) {
    if (error.intakeHoldReleased || ['APPOINTMENT_CONFIRMATION_PENDING', 'DISTRIBUTED_LEASE_LOST'].includes(error.code)) return;
    if (!['INTAKE_REVIEW_CHANGED', 'INTAKE_VOICE_ACTIVE'].includes(error.code) && isDefiniteRejection(error, appointment.confirmationIntent.provider, earlierAttempts)) {
      await failed(appointment, error);
    } else {
      await intent.defer(appointment, retryDelay(earlierAttempts));
      await report(appointment, error);
    }
  }

  async function processProvider({ appointment, business, provider, service, recovering = false }) {
    const { attempts } = appointment.confirmationIntent;
    if (appointment.confirmationIntent.compensation?.eventId) return compensate(appointment, provider);
    try {
      appointment = await prepareTarget(appointment, provider);
    } catch (error) {
      await handleProviderFailure(appointment, error, attempts);
      throw error;
    }
    crash('before_provider');
    let receipt;
    try {
      if (recovering) receipt = await lookupOrRetry({ appointment, business, provider });
      if (!receipt) {
        await assertIntakeHoldCurrent(appointment);
        assertDistributedLeaseActive();
        const claimed = await intent.patch(appointment, { 'confirmationIntent.attempts': attempts + 1 });
        if (!claimed || claimed.confirmationIntent.leaseUntil <= clock()) throw confirmationPending();
        appointment = claimed;
        assertDistributedLeaseActive();
        receipt = await provider.createAppointment({ appointment, service, target: appointment.confirmationIntent.target });
      }
    } catch (error) {
      await handleProviderFailure(appointment, error, attempts);
      throw error;
    }
    try {
    if (!receipt) throw Object.assign(new Error('Provider returned no confirmation receipt'), { code: 'PROVIDER_CONFIRMATION_UNCERTAIN' });
    if (receipt.kind === 'handoff') {
      const error = Object.assign(new Error('The provider saved a handoff request. An appointment has not been verified.'), {
        code: 'PROVIDER_HANDOFF_ONLY', confirmationRejected: true,
      });
      throw error;
    }
    await verifyExternalConfirmation({ appointment, provider, receipt });
    } catch (error) {
      await handleProviderFailure(appointment, error, attempts);
      throw error;
    }
    crash('after_provider');
    const saved = await finalize(appointment, provider, receipt, recovering);
    crash('after_commit');
    return saved;
  }

  return {
    processProvider,

    async reconcile(afterCommit, { limit = 25 } = {}) {
      const deadline = Date.now() + 30_000;
      const rows = await intent.listDue(limit);
      for (const row of rows) {
        if (Date.now() >= deadline) break;
        let appointment;
        try {
          appointment = await intent.claim(row);
          if (!appointment) continue;
          if (appointment.status === 'failed') {
            await finishFailure(appointment, new Error(appointment.failureReason));
            continue;
          }
          const business = await Business.findById(appointment.business);
          if (!business) throw new Error('The confirmation business no longer exists.');
          const service = await ServiceOffering.findOne({ _id: appointment.serviceOffering, business: appointment.business });
          if (appointment.status !== 'confirmed') {
            const provider = SchedulingProviderFactory.getProvider(business, appointment.confirmationIntent.provider);
            appointment = await processProvider({ appointment, business, provider, service, recovering: true });
          }
          if (appointment) await afterCommit(appointment, business, service, { recovering: true });
        } catch (error) {
          if (appointment) await intent.defer(appointment, retryDelay(appointment.confirmationIntent.attempts)).catch(() => {});
          safeConsole.error('appointment.confirm.recovery_failed', { appointmentId: String(row._id), error: error.message });
        }
      }
    },
  };
}
