import { claimRescheduleOriginal } from '../../stateTransitions/appointmentOwnership.js';
import { readReschedule, findCompletedReschedule, prepareReschedule } from './prepare.js';
import { providerHandoff } from './providerHandoff.js';
import { reserveReplacement, stageHandoff, confirmReplacement, reconcileOriginal } from './finalize.js';
import { replacementSnapshot, recoverReschedule } from './recovery.js';
import { followUp } from './followUp.js';

async function executeReschedule(request, dependencies) {
  const { business, input } = request;
  let { original, key, replacement: found } = await readReschedule(request, dependencies.read);
  let replacement = found;
  if (replacement && !replacement.rescheduledFrom && replacement.status === 'held') {
    ({ replacement } = await reserveReplacement({ business, original, replacement, input }, {}));
  }
  const completed = await findCompletedReschedule({ business, original, replacement }, dependencies.read);
  if (completed.appointment) {
    if (replacement?.status === 'confirmed') await reconcileOriginal({ original, replacement }, dependencies.decide);
    await dependencies.repair(completed.appointment, business);
    return completed.appointment;
  }
  const { service, nextInput } = await prepareReschedule({ business, original, replacement, input }, dependencies.decide);
  original = await claimRescheduleOriginal({ Appointment: dependencies.read.Appointment, original, business, key, input });
  ({ replacement } = await reserveReplacement({ business, original, replacement, key, service, nextInput, input }, dependencies.reserve));
  const provider = dependencies.provider.getProvider(business, original.provider || 'internal');
  const snapshot = replacementSnapshot(replacement);
  let handoff = replacement.status === 'held' && !original.externalAppointmentId && replacement.pendingRescheduleExternalAppointmentId
    ? { applied: true, receipt: { externalAppointmentId: replacement.pendingRescheduleExternalAppointmentId,
      externalCalendarId: replacement.pendingRescheduleExternalCalendarId } } : null;
  try {
    handoff = await providerHandoff({ original, replacement, service }, { provider });
    await stageHandoff({ original, replacement, handoff });
    await confirmReplacement({ replacement, receipt: handoff.receipt }, dependencies.confirm);
    await reconcileOriginal({ original, replacement }, dependencies.decide);
  } catch (error) {
    await recoverReschedule({ business, original, replacement, key, snapshot, handoff, error }, { ...dependencies.recovery, provider });
    throw error;
  }
  return (await followUp({ business, original, replacement }, dependencies.effects)).appointment;
}

/** Explicit composition; each phase receives only its own capabilities, never a shared mutable context. */
export function createRescheduleCommand({ Appointment, InterventionService, Lead, SchedulingProviderFactory, SocketService,
  addMinutes, assertTransition, cancelAppointmentNotifications, createHold, crypto, exactSlotAvailable,
  getAppointmentForBusiness, getBookableService, lifecycleMarker, normalizeAddress,
  runNonBlockingAppointmentSideEffect, scheduleAppointmentReminders, tryRepairAppointmentLifecycle }) {
  const reschedule = async request => executeReschedule(request, {
    read: { Appointment, getAppointmentForBusiness, normalizeAddress, crypto },
    decide: { assertTransition, getBookableService, exactSlotAvailable, addMinutes }, reserve: { createHold },
    provider: SchedulingProviderFactory, confirm: { lifecycleMarker }, recovery: { Appointment, InterventionService },
    repair: tryRepairAppointmentLifecycle,
    effects: { Lead, cancelAppointmentNotifications, scheduleAppointmentReminders, tryRepairAppointmentLifecycle,
      runNonBlockingAppointmentSideEffect, SocketService },
  });
  return { reschedule };
}
