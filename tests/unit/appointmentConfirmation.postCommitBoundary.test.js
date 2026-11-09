import { assertConfirmationNotPending, confirmationPending } from '../../src/services/scheduling/appointmentConfirmationIntent.repository.js';
import { confirmWithoutRecovery } from '../../src/services/scheduling/commands/confirmWithoutRecovery.js';
// No database, Twilio, Stripe or network calls. Authorized change: after a durable
// status=confirmed save, a secondary effect failure cannot become an HTTP failure.
import { applyAppointmentBookingTransition } from '../../src/services/booking/appointmentBookingTransition.repository.js';
import { createConfirmationRecovery } from '../../src/services/scheduling/appointmentConfirmationRecovery.service.js';
import { createAppointmentconfirm1Methods } from '../../src/services/scheduling/commands/confirm-1.js';

const fixture = () => {
  const appointment = {
    _id:'a1', business:'b1', lead:'l1', conversation:'c1', serviceOffering:'s1',
    status:'held', provider:'internal', bookedBy:'staff', requiresBusinessApproval:false,
    automaticConfirmationAuthorized:false, address:{postalCode:'30301'},
    startAt:new Date('2027-01-15T17:00:00Z'), endAt:new Date('2027-01-15T18:30:00Z'),
    toObject() { return {...this}; }, save:jest.fn(async () => {}),
  };
  const business={_id:'b1'};
  const provider={
    createAppointment:jest.fn(async () => ({provider:'internal',externalAppointmentId:'internal:a1',externalCalendarId:'callbackiq'})),
    cancelAppointment:jest.fn(async () => ({})),
  };
  const intent = {
    begin: jest.fn(async (row, approvedBy, provider) => {
      row.confirmationIntent = { approvedBy, provider, attempts: 0, status: 'pending_provider' };
      return row;
    }),
    patch: jest.fn(async (row, fields) => {
      for (const [key, value] of Object.entries(fields)) {
        if (key.startsWith('confirmationIntent.')) row.confirmationIntent[key.split('.')[1]] = value;
        else row[key] = value;
      }
      if (fields.status === 'confirmed') {
        try { await row.save(); }
        catch (error) {
          row.status = 'held';
          row.confirmationIntent.status = 'pending_provider';
          throw error;
        }
      }
      return row;
    }),
    getCommitted: jest.fn(async () => null), finishEffects: jest.fn(), defer: jest.fn(),
  };
  const deps={
    assertConfirmationNotPending, confirmationPending, confirmWithoutRecovery,
    applyAppointmentBookingTransition, intent, businessCalendarProviderName: jest.fn(() => "internal"),
    getAppointmentForBusiness:jest.fn(async()=>appointment),
    assertTransition:jest.fn(), assertServiceRequestEligible:jest.fn(async()=>true),
    exactSlotAvailable:jest.fn(async()=>true),
    preservePendingApprovalOnAvailabilityConflict:jest.fn(()=>false),
    ServiceOffering:{findById:jest.fn(async()=>({_id:'s1'}))},
    Lead:{findById:jest.fn(async()=>({_id:'l1'}))},
    SchedulingProviderFactory:{getProvider:jest.fn(()=>provider)},
    Conversation:{updateOne:jest.fn(async()=>({}))},
    InterventionService:{create:jest.fn(async()=>({})),integrationFailure:jest.fn(async()=>({}))},
    SocketService:{emitToBusiness:jest.fn(),emitDashboardRefresh:jest.fn()},
    lifecycleMarker:jest.fn(()=>({key:'lifecycle_confirmed',pending:true})),
    projectionMarker:jest.fn(()=>({token:'test',pending:true})),
    resolveApprovalReview:jest.fn(async()=>null),
    ensureBusinessApprovalNotice:jest.fn(async()=>({})),
    runNonBlockingAppointmentSideEffect:jest.fn(async({task})=>task()),
    tryRepairAppointmentLifecycle:jest.fn(async()=>({})),
    tryRepairAppointmentProjections:jest.fn(async()=>({})),
    scheduleAppointmentReminders:jest.fn(async()=>[]),
    safeConsole:{error:jest.fn()}, assertDistributedLeaseActive:jest.fn(),
  };
  deps.recovery = createConfirmationRecovery(deps);
  return {appointment,business,provider,deps,confirm:createAppointmentconfirm1Methods(deps).confirm};
};

describe('appointment confirmation durable boundary',()=>{
  test('reminder and intervention failures do not reject a persisted booking',async()=>{
    const f=fixture();
    f.deps.scheduleAppointmentReminders.mockRejectedValue(new Error('reminders offline'));
    f.deps.InterventionService.create.mockRejectedValue(new Error('intervention DB offline'));
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).resolves.toBe(f.appointment);
    expect(f.appointment.status).toBe('confirmed');
    expect(f.appointment.save).toHaveBeenCalledTimes(1);
    expect(f.deps.InterventionService.create).toHaveBeenCalledWith(expect.objectContaining({
      type:'integration_failure',appointmentId:'a1',dedupeKey:'appointment_reminder_schedule:a1',
    }));
    expect(f.deps.safeConsole.error).toHaveBeenCalledWith(
      'appointment.confirm.post_commit_effect_failed',
      expect.objectContaining({businessId:'b1',appointmentId:'a1',effect:'reminder_failure_intervention'}));
    expect(f.deps.SocketService.emitToBusiness).toHaveBeenCalledWith('b1','appointment:confirmed',f.appointment);
  });
  test('reminder failure still records durable human intervention when possible',async()=>{
    const f=fixture();f.deps.scheduleAppointmentReminders.mockRejectedValue(new Error('temporary outage'));
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).resolves.toHaveProperty('status','confirmed');
    expect(f.deps.InterventionService.create).toHaveBeenCalledTimes(1);
  });
  test('socket and projection exceptions after save are contained',async()=>{
    const f=fixture();
    f.deps.SocketService.emitToBusiness.mockImplementation(()=>{throw Error('socket offline')});
    f.deps.tryRepairAppointmentProjections.mockRejectedValue(Error('projection failed'));
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).resolves.toBe(f.appointment);
    expect(f.deps.SocketService.emitDashboardRefresh).toHaveBeenCalledWith('b1','appointment_confirmed');
  });
  test('provider failure still rejects and never emits confirmed event',async()=>{
    const f=fixture();f.provider.createAppointment.mockRejectedValue(Error('provider rejected'));
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).rejects.toThrow('provider rejected');
    expect(f.appointment.status).toBe('failed');
    expect(f.deps.SocketService.emitToBusiness).not.toHaveBeenCalled();
  });
  test('Mongo save failure rejects and triggers provider compensation',async()=>{
    const f=fixture();
    f.appointment.save.mockRejectedValueOnce(Error('Mongo failure')).mockResolvedValueOnce(undefined);
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).rejects.toThrow('Mongo failure');
    expect(f.provider.cancelAppointment).toHaveBeenCalledTimes(1);
    expect(f.appointment.status).toBe('failed');
  });
  test('provider acceptance does not notify anyone while Mongo confirmation is pending', async () => {
    const f = fixture();
    f.appointment.requiresBusinessApproval = true;
    let releaseSave;
    let enteredSave;
    const saveStarted = new Promise((resolve) => { enteredSave = resolve; });
    f.appointment.save.mockImplementationOnce(() => {
      enteredSave();
      return new Promise((resolve) => { releaseSave = resolve; });
    });

    const confirmation = f.confirm({ business: f.business, appointmentId: 'a1' });
    await saveStarted;
    expect(f.provider.createAppointment).toHaveBeenCalledTimes(1);
    expect(f.deps.ensureBusinessApprovalNotice).not.toHaveBeenCalled();
    expect(f.deps.Conversation.updateOne).not.toHaveBeenCalled();
    expect(f.deps.SocketService.emitToBusiness).not.toHaveBeenCalled();

    releaseSave();
    await expect(confirmation).resolves.toHaveProperty('status', 'confirmed');
    expect(f.deps.ensureBusinessApprovalNotice).toHaveBeenCalledTimes(1);
    expect(f.deps.SocketService.emitToBusiness).toHaveBeenCalledTimes(1);
  });

  test('ambiguous provider timeout triggers staff review and leaves no confirmed notice', async () => {
    const f = fixture();
    f.appointment.requiresBusinessApproval = true;
    f.deps.businessCalendarProviderName.mockReturnValue("google_calendar");
    const timeout = Object.assign(new Error('provider outcome unknown'), { code: 'ETIMEDOUT' });
    f.provider.createAppointment.mockRejectedValueOnce(timeout);
    await expect(f.confirm({ business: f.business, appointmentId: 'a1' })).rejects.toBe(timeout);
    expect(f.appointment.status).toBe('held');
    expect(f.appointment.confirmationIntent.status).toBe("pending_provider");
    expect(f.provider.cancelAppointment).not.toHaveBeenCalled();
    expect(f.deps.InterventionService.integrationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'b1', appointmentId: 'a1', error: timeout }),
    );
    expect(f.deps.ensureBusinessApprovalNotice).not.toHaveBeenCalled();
    expect(f.deps.SocketService.emitToBusiness).not.toHaveBeenCalled();
  });

  test('failed compensation records a tenant-scoped orphan intervention', async () => {
    const f = fixture();
    const persistenceFailure = new Error('Mongo commit failed');
    f.appointment.save.mockRejectedValueOnce(persistenceFailure).mockResolvedValueOnce(undefined);
    f.provider.cancelAppointment.mockRejectedValueOnce(new Error('provider cleanup timed out'));
    await expect(f.confirm({ business: f.business, appointmentId: 'a1' })).rejects.toBe(persistenceFailure);

    expect(f.deps.InterventionService.create).toHaveBeenCalledWith(expect.objectContaining({
      businessId: 'b1',
      appointmentId: 'a1',
      dedupeKey: 'appointment_confirmation_cleanup:a1:internal:a1',
      metadata: expect.objectContaining({ externalAppointmentId: 'internal:a1' }),
    }));
    expect(f.appointment.confirmationIntent.compensation).toMatchObject({ eventId: 'internal:a1' });
    expect(f.deps.SocketService.emitToBusiness).not.toHaveBeenCalled();
  });

  test('already confirmed replay still avoids external insert',async()=>{
    const f=fixture();f.appointment.status='confirmed';
    f.deps.tryRepairAppointmentLifecycle.mockRejectedValue(Error('replay repair transient'));
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).resolves.toBe(f.appointment);
    expect(f.provider.createAppointment).not.toHaveBeenCalled();
  });

  // ADDITIONAL CHARACTERIZATION: authorized confirmation states and defensive post-save branches.
  test('staff approval persists the approval decision and schedules the existing confirmation notice', async () => {
    const f = fixture();
    f.appointment.requiresBusinessApproval = true;
    await expect(f.confirm({business:f.business,appointmentId:'a1',approvedBy:'staff01'})).resolves.toBe(f.appointment);
    expect(f.appointment.status).toBe('confirmed');
    expect(f.appointment.approvalDecisionBy).toBe('staff01');
    expect(f.appointment.approvalDecisionAt).toBeInstanceOf(Date);
    expect(f.deps.ensureBusinessApprovalNotice).toHaveBeenCalledTimes(1);
    expect(f.deps.Conversation.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({_id:'c1',business:'b1','bookingState.appointment':{$in:['a1',null]}}),
      {$set:expect.objectContaining({'bookingState.status':'booked','bookingState.appointment':'a1'})}
    );
  });

  test('automatic confirmation with no conversation does not manufacture conversation state', async () => {
    const f = fixture();
    f.appointment.automaticConfirmationAuthorized = true;
    f.appointment.conversation = null;
    f.appointment.lead = null;
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).resolves.toBe(f.appointment);
    expect(f.deps.ensureBusinessApprovalNotice).toHaveBeenCalledTimes(1);
    expect(f.deps.Conversation.updateOne).not.toHaveBeenCalled();
    expect(f.deps.assertServiceRequestEligible).not.toHaveBeenCalled();
  });

  test('failed approval confirmation notice cannot reverse persisted confirmation', async () => {
    const f = fixture();
    f.appointment.requiresBusinessApproval = true;
    f.deps.ensureBusinessApprovalNotice.mockRejectedValue(Error('notice adapter unavailable'));
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).resolves.toHaveProperty('status','confirmed');
    expect(f.deps.safeConsole.error).toHaveBeenCalledWith(
      'appointment.confirm.post_commit_effect_failed',
      expect.objectContaining({effect:'approval_confirmation_notice',businessId:'b1',appointmentId:'a1'})
    );
    expect(f.deps.scheduleAppointmentReminders).toHaveBeenCalledTimes(1);
  });

  test('failure in a nonblocking notice adapter is contained after the save', async () => {
    const f = fixture();
    f.appointment.automaticConfirmationAuthorized = true;
    f.deps.runNonBlockingAppointmentSideEffect.mockRejectedValue(Error('adapter failed to contain'));
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).resolves.toBe(f.appointment);
    expect(f.deps.safeConsole.error).toHaveBeenCalledWith(
      'appointment.confirm.post_commit_effect_failed',
      expect.objectContaining({effect:'approval_confirmation_notice'})
    );
    expect(f.deps.SocketService.emitToBusiness).toHaveBeenCalledWith('b1','appointment:confirmed',f.appointment);
  });

  test('already-confirmed replay tolerates both lifecycle and projection repair failures', async () => {
    const f = fixture();
    f.appointment.status = 'confirmed';
    f.deps.tryRepairAppointmentLifecycle.mockRejectedValue(Error('lifecycle unavailable'));
    f.deps.tryRepairAppointmentProjections.mockRejectedValue(Error('projection unavailable'));
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).resolves.toBe(f.appointment);
    expect(f.provider.createAppointment).not.toHaveBeenCalled();
    expect(f.appointment.save).not.toHaveBeenCalled();
    expect(f.deps.safeConsole.error).toHaveBeenCalledWith(
      'appointment.confirm.post_commit_effect_failed',
      expect.objectContaining({effect:'existing_projection_repair'})
    );
  });

  test('logging failure cannot change the result of a durably confirmed appointment', async () => {
    const f = fixture();
    f.deps.scheduleAppointmentReminders.mockRejectedValue(Error('reminders temporarily unavailable'));
    f.deps.InterventionService.create.mockRejectedValue(Error('interventions temporarily unavailable'));
    f.deps.safeConsole.error.mockImplementation(() => { throw Error('logging unavailable'); });
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).resolves.toBe(f.appointment);
    expect(f.appointment.status).toBe('confirmed');
    expect(f.appointment.save).toHaveBeenCalledTimes(1);
  });

  test('post-commit lifecycle failure does not prevent further repair or completion', async () => {
    const f = fixture();
    f.deps.tryRepairAppointmentLifecycle.mockRejectedValue(Error('lifecycle I/O failed'));
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).resolves.toHaveProperty('status','confirmed');
    expect(f.deps.tryRepairAppointmentProjections).toHaveBeenCalledTimes(1);
    expect(f.deps.SocketService.emitDashboardRefresh).toHaveBeenCalledWith('b1','appointment_confirmed');
  });

  test('provider result without external ID cannot trigger the orphan-event cancellation path', async () => {
    const f = fixture();
    f.provider.createAppointment.mockResolvedValue({provider:'internal'});
    f.appointment.save.mockRejectedValueOnce(Error('Mongo durable save failed')).mockResolvedValueOnce(undefined);
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).rejects.toThrow('Mongo durable save failed');
    expect(f.provider.cancelAppointment).not.toHaveBeenCalled();
    expect(f.deps.InterventionService.integrationFailure).toHaveBeenCalledTimes(1);
    expect(f.deps.SocketService.emitToBusiness).not.toHaveBeenCalled();
  });

  test('a still-valid staff hold is preserved on final availability conflict', async () => {
    const f = fixture();
    f.deps.exactSlotAvailable.mockResolvedValue(false);
    f.deps.preservePendingApprovalOnAvailabilityConflict.mockReturnValue(true);
    await expect(f.confirm({business:f.business,appointmentId:'a1'})).rejects.toMatchObject({
      statusCode:409, code:'SLOT_UNAVAILABLE'
    });
    expect(f.appointment.status).toBe('held');
    expect(f.provider.createAppointment).not.toHaveBeenCalled();
  });

  // DIAGNOSTIC CHARACTERIZATION: exercise exactly the missing LCOV arms reported
  // for src/services/scheduling/commands/confirm-1.js on 2026-11-05.
  // These are defensive legacy/error-path contracts, not normal booking inputs.
  test('already-confirmed replay logs an unstructured rejection with missing diagnostic IDs', async () => {
    const f = fixture();
    f.appointment.status = 'confirmed';
    // A repair adapter can fail when historical metadata is incomplete. The
    // structured error logger must preserve a committed confirmation regardless.
    f.business._id = undefined;
    f.appointment._id = undefined;
    f.deps.tryRepairAppointmentLifecycle.mockRejectedValue('legacy repair rejected without Error');
    await expect(f.confirm({ business: f.business, appointmentId: 'a1' })).resolves.toBe(f.appointment);
    expect(f.deps.safeConsole.error).toHaveBeenCalledWith(
      'appointment.confirm.post_commit_effect_failed',
      expect.objectContaining({
        businessId: '',
        appointmentId: '',
        effect: 'existing_lifecycle_repair',
        error: 'legacy repair rejected without Error',
      }),
    );
    expect(f.provider.createAppointment).not.toHaveBeenCalled();
    expect(f.appointment.save).not.toHaveBeenCalled();
  });

  test('provider failure reports internal fallback when legacy provider field is absent', async () => {
    const f = fixture();
    f.appointment.provider = '';
    f.provider.createAppointment.mockRejectedValue(new Error('provider unavailable'));
    await expect(f.confirm({ business: f.business, appointmentId: 'a1' }))
      .rejects.toThrow('provider unavailable');
    expect(f.deps.InterventionService.integrationFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'internal',
        appointmentId: 'a1',
        businessId: 'b1',
      }),
    );
    expect(f.deps.SocketService.emitToBusiness).not.toHaveBeenCalled();
  });

  test('reminder failure logs internal fallback when persisted booking has no provider label', async () => {
    const f = fixture();
    f.appointment.provider = '';
    f.provider.createAppointment.mockResolvedValue({});
    f.deps.scheduleAppointmentReminders.mockRejectedValue(new Error('reminder queue unreachable'));
    await expect(f.confirm({ business: f.business, appointmentId: 'a1' })).resolves.toBe(f.appointment);
    expect(f.appointment.status).toBe('confirmed');
    expect(f.deps.InterventionService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        appointmentId: 'a1',
        type: 'integration_failure',
        metadata: { provider: 'internal' },
      }),
    );
    expect(f.deps.safeConsole.error).toHaveBeenCalledWith(
      'appointment.confirm.post_commit_effect_failed',
      expect.objectContaining({effect: 'reminder_scheduling'}),
    );
  });

});

  test('success persists provider references before reminders and tenant socket events', async () => {
    const f = fixture();
    const order = [];
    f.provider.createAppointment.mockImplementationOnce(async () => {
      order.push('provider');
      return { provider: 'google_calendar', externalAppointmentId: 'calendar-event', externalCalendarId: 'tenant-calendar' };
    });
    f.appointment.save.mockImplementationOnce(async () => {
      expect(f.appointment).toMatchObject({
        status: 'confirmed', provider: 'google_calendar', externalAppointmentId: 'calendar-event', externalCalendarId: 'tenant-calendar',
        heldExpiresAt: null, failureReason: '', approvalRecovery: { state: 'resolved', reconciled: false },
      });
      expect(f.appointment.confirmedAt).toBeInstanceOf(Date);
      order.push('commit');
    });
    f.deps.scheduleAppointmentReminders.mockImplementationOnce(async () => { order.push('reminders'); });
    f.deps.SocketService.emitToBusiness.mockImplementationOnce((businessId, event, appointment) => {
      expect([businessId, event, appointment._id]).toEqual(['b1', 'appointment:confirmed', 'a1']);
      order.push('socket');
    });

    await f.confirm({ business: f.business, appointmentId: 'a1' });
    expect(order).toEqual(['provider', 'commit', 'reminders', 'socket']);
  });

describe('confirmation compatibility', () => {
  test('expired hold releases capacity without creating an intent or contacting the provider', async () => {
    const f = fixture();
    f.appointment.heldExpiresAt = new Date(0);
    await expect(f.confirm({ business: f.business, appointmentId: 'a1' })).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });
    expect(f.appointment).toMatchObject({ status: 'failed', activeSlotKey: null, slotClaimKeys: [] });
    expect(f.deps.intent.begin).not.toHaveBeenCalled();
    expect(f.provider.createAppointment).not.toHaveBeenCalled();
  });

  test('unavailable ordinary hold releases capacity without creating an intent', async () => {
    const f = fixture();
    f.deps.exactSlotAvailable.mockResolvedValue(false);
    await expect(f.confirm({ business: f.business, appointmentId: 'a1' })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(f.appointment).toMatchObject({ status: 'failed', activeSlotKey: null, slotClaimKeys: [] });
    expect(f.deps.intent.begin).not.toHaveBeenCalled();
  });

  test('provider outside recovery scope keeps the legacy provider call and reminder schedule', async () => {
    const f = fixture();
    f.deps.businessCalendarProviderName.mockReturnValue('jobber');
    f.provider.createAppointment.mockResolvedValue({ provider: 'jobber', externalAppointmentId: 'visit', externalCalendarId: 'jobber' });
    f.appointment.requiresBusinessApproval = true;
    await expect(f.confirm({ business: f.business, appointmentId: 'a1', approvedBy: 'staff' })).resolves.toMatchObject({
      status: 'confirmed', externalAppointmentId: 'visit', approvalDecisionBy: 'staff',
    });
    expect(f.provider.createAppointment).toHaveBeenCalledWith({ appointment: f.appointment, service: { _id: 's1' } });
    expect(f.deps.intent.begin).not.toHaveBeenCalled();
    expect(f.deps.scheduleAppointmentReminders).toHaveBeenCalledWith({ appointment: f.appointment });
  });

  test('provider outside recovery scope retains catch-path compensation', async () => {
    const f = fixture();
    f.deps.businessCalendarProviderName.mockReturnValue('jobber');
    f.provider.createAppointment.mockResolvedValue({ provider: 'jobber', externalAppointmentId: 'visit' });
    f.appointment.save.mockRejectedValueOnce(Error('Mongo unavailable'));
    await expect(f.confirm({ business: f.business, appointmentId: 'a1' })).rejects.toThrow('Mongo unavailable');
    expect(f.provider.cancelAppointment).toHaveBeenCalledTimes(1);
    expect(f.deps.intent.begin).not.toHaveBeenCalled();
  });

  test('provider outside recovery scope retains legacy failed-compensation alert', async () => {
    const f = fixture();
    f.deps.businessCalendarProviderName.mockReturnValue('jobber');
    f.provider.createAppointment.mockResolvedValue({ provider: 'jobber', externalAppointmentId: 'visit' });
    f.appointment.save.mockRejectedValueOnce(Error('Mongo unavailable')).mockRejectedValueOnce(Error('still unavailable'));
    f.provider.cancelAppointment.mockRejectedValueOnce(Error('provider cleanup error'));
    await expect(f.confirm({ business: f.business, appointmentId: 'a1' })).rejects.toThrow('Mongo unavailable');
    expect(f.deps.InterventionService.create).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'google_orphan_cleanup:a1:visit',
    }));
    expect(f.deps.intent.begin).not.toHaveBeenCalled();
  });
});

test('a concurrent confirmation winning the intent compare-and-set prevents provider calls', async () => {
  const f = fixture();
  f.deps.intent.begin.mockResolvedValue(null);
  await expect(f.confirm({ business: f.business, appointmentId: 'a1' })).rejects.toMatchObject({
    code: 'APPOINTMENT_CONFIRMATION_PENDING',
  });
  expect(f.provider.createAppointment).not.toHaveBeenCalled();
});

test('legacy provider rejection without an external receipt retains the default intervention provider', async () => {
  const f = fixture();
  f.deps.businessCalendarProviderName.mockReturnValue('jobber');
  f.appointment.provider = '';
  f.provider.createAppointment.mockRejectedValue(Error('legacy provider unavailable'));
  await expect(f.confirm({ business: f.business, appointmentId: 'a1' })).rejects.toThrow('legacy provider unavailable');
  expect(f.provider.cancelAppointment).not.toHaveBeenCalled();
  expect(f.deps.InterventionService.integrationFailure).toHaveBeenCalledWith(expect.objectContaining({ provider: 'internal' }));
});
