import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Appointment from '../../src/models/appointment.js';
import Lead from '../../src/models/lead.js';
import { createRescheduleCommand } from '../../src/services/scheduling/reschedule/command.js';
import { createAppointmentcancel1Methods } from '../../src/services/scheduling/commands/cancel-1.js';
import { assertConfirmationNotPending } from '../../src/services/scheduling/appointmentConfirmationIntent.repository.js';
import { assertTransition } from '../../src/services/scheduling/appointmentStatePolicy.service.js';
export async function stabilizationSchedulingFixture() {
  const business = { _id: new mongoose.Types.ObjectId(), businessName: 'Synthetic scheduling', timezone: 'America/New_York' };
  const service = { _id: new mongoose.Types.ObjectId(), durationMinutes: 60 }, noop = async () => {};
  const startAt = new Date(Date.now() + 7 * 86400000), endAt = new Date(+startAt + 3600000);
  const original = await Appointment.create({ business: business._id, serviceOffering: service._id, customerPhone: '+14045550100',
    startAt, endAt, status: 'confirmed', provider: 'google_calendar', externalAppointmentId: 'event', externalCalendarId: 'calendar',
    idempotencyKey: 'original', activeSlotKey: 'original', slotClaimKeys: ['original'], capacityLane: 1 });
  const events = new Map([['event', { startAt, endAt }]]);
  const provider = { updateAppointment: jest.fn(async ({ changes }) => { events.set('event', changes); return { provider: 'google_calendar', externalAppointmentId: 'event', externalCalendarId: 'calendar' }; }),
    cancelAppointment: jest.fn(async () => events.delete('event')) };
  const deps = { Appointment, Lead, crypto, assertTransition, assertConfirmationNotPending,
    lifecycleMarker: key => ({ key, pending: false }), cancelAppointmentNotifications: noop, scheduleAppointmentReminders: noop,
    addMinutes: (date, minutes) => new Date(+new Date(date) + minutes * 60000), normalizeAddress: value => value,
    getAppointmentForBusiness: (businessId, id) => Appointment.findOne({ _id: id, business: businessId }),
    getBookableService: async () => service, exactSlotAvailable: async () => true,
    createHold: ({ input, idempotencyKey }) => Appointment.create({ ...input, business: business._id, serviceOffering: service._id,
      status: 'held', idempotencyKey, heldExpiresAt: input.heldExpiresAt || new Date(Date.now() + 300000), activeSlotKey: 'replacement', slotClaimKeys: ['replacement'], capacityLane: 1 }),
    SchedulingProviderFactory: { getProvider: () => provider }, InterventionService: { create: jest.fn(), integrationFailure: jest.fn() },
    SocketService: { emitToBusiness: jest.fn(), emitDashboardRefresh: jest.fn() },
    runNonBlockingAppointmentSideEffect: ({ task }) => task(), tryRepairAppointmentLifecycle: noop, ensureCancellationSideEffects: noop, resolveApprovalReview: noop };
  const input = { startAt: new Date(+startAt + 86400000), endAt: new Date(+endAt + 86400000) };
  return { business, original, provider, events, deps, run: () => createRescheduleCommand(deps).reschedule({ business, appointmentId: original._id, input, idempotencyKey: 'same-key' }),
    cancel: () => createAppointmentcancel1Methods(deps).cancel({ business, appointmentId: original._id }) };
}
