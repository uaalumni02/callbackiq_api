/** Scheduling edge cases exercise real extracted commands without network/db I/O. */
import assert from 'node:assert/strict';
import { assertConfirmationNotPending } from '../../src/services/scheduling/appointmentConfirmationIntent.repository.js';
import { createAppointmentrecheckAndConfirm1Methods } from '../../src/services/scheduling/commands/recheckAndConfirm-1.js';
import { createAppointmentreschedule1Methods } from '../../src/services/scheduling/commands/reschedule-1.js';

const business = { _id:'tenant-1', timezone:'America/New_York' };
function original(overrides={}) { return {
  _id:'original-1', status:'held', serviceOffering:'offering-1',
  startAt:new Date('2026-11-12T10:00:00Z'), endAt:new Date('2026-11-12T11:00:00Z'),
  timezone:'America/New_York', heldExpiresAt:new Date(0), requiresBusinessApproval:true,
  failureReason:'', address:{postalCode:'30301'},
  toObject() { return {...this}; },
  async save() { return this; }, ...overrides,
}; }
function approvalFixture(a=original(), overrides={}) {
  const events=[];
  const deps={
    assertConfirmationNotPending, assertIntakeHoldCurrent: async () => {},
    Appointment:{ async findOneAndUpdate(filter, patch, opts) {
      events.push(['claim', filter, patch, opts]);
      return original({...a, status:'held', heldExpiresAt: new Date(Date.now()+300000)});
    } },
    addMinutes:(date, min)=>new Date(+date+min*60000),
    assertDistributedLeaseActive:()=>events.push(['lease-checked']),
    exactSlotAvailable:async()=>true,
    getAppointmentForBusiness:async()=>a,
    getSlotCapacity:async()=>1,
    getSlotClaimKeys:()=>['slot-claim'],
    getSlotKey:()=> 'slot-key',
    repairConfirmedApproval:async()=>events.push(['repair-confirmed']),
    tryRepairAppointmentProjections:async()=>events.push(['repair-projection']),
    withDistributedLease:async (_key, action)=>({ acquired:true, value:await action() }),
    ...overrides,
  };
  const methods=createAppointmentrecheckAndConfirm1Methods(deps);
  const receiver={ confirm:async args=>{ events.push(['confirm',args]); return {confirmed:true}; } };
  const invoke=(approvedBy='staff-1')=>methods.recheckAndConfirm.call(receiver, {business,appointmentId:'original-1',approvedBy});
  return {events,invoke};
}

test('staff approval is mandatory even before a scheduling lease',async()=>{
  const f=approvalFixture();
  await assert.rejects(()=>f.invoke(null),error=>error.statusCode===403);
  assert.equal(f.events.length,0);
});

test('a previously confirmed appointment is repaired without duplicate provider confirmation',async()=>{
  const f=approvalFixture(original({status:'confirmed'}));
  const out=await f.invoke();
  assert.equal(out.status,'confirmed');
  assert.ok(f.events.some(x=>x[0]==='repair-confirmed'));
  assert.ok(f.events.some(x=>x[0]==='repair-projection'));
  assert.ok(!f.events.some(x=>x[0]==='confirm'));
});

test('active hold reuses existing confirmation rather than claiming another slot',async()=>{
  const f=approvalFixture(original({heldExpiresAt:new Date(Date.now()+900000)}));
  assert.deepEqual(await f.invoke(),{confirmed:true});
  assert.ok(!f.events.some(x=>x[0]==='claim'));
});

test('staff recheck cannot reclaim a slot while its provider confirmation is pending', async () => {
  const f = approvalFixture(original({ confirmationIntent: { status: 'pending_provider' } }));
  await assert.rejects(() => f.invoke(), (error) => error.code === 'APPOINTMENT_CONFIRMATION_PENDING');
  assert.deepEqual(f.events, []);
});

test('only held or qualifying failed holds can be rechecked',async()=>{
  const f=approvalFixture(original({status:'canceled'}));
  await assert.rejects(()=>f.invoke(),error=>error.statusCode===409);
});

test('expired hold refuses an unavailable slot without committing changes',async()=>{
  const f=approvalFixture(original(),{exactSlotAvailable:async()=>false});
  await assert.rejects(()=>f.invoke(),error=>error.code==='SLOT_UNAVAILABLE');
  assert.ok(!f.events.some(x=>x[0]==='claim'));
});

test('expired hold claims a tenant-scoped lane and preserves business approval',async()=>{
  const f=approvalFixture();
  assert.deepEqual(await f.invoke(),{confirmed:true});
  const claim=f.events.find(x=>x[0]==='claim');
  assert.deepEqual(claim[1], {
    _id: 'original-1', business: 'tenant-1', status: 'held',
    'confirmationIntent.status': { $ne: 'pending_provider' },
    'rescheduleIntent.key': { $exists: false },
  });
  assert.equal(claim[2].$set.capacityLane,1);
  assert.deepEqual(claim[2].$set.slotClaimKeys,['slot-claim']);
  assert.ok(f.events.some(x=>x[0]==='confirm'));
});

test('duplicate-key claim retries the next capacity lane only',async()=>{
  let attempt=0;
  const f=approvalFixture(original(),{
    getSlotCapacity:async()=>2,
    Appointment:{async findOneAndUpdate() {
      attempt++;
      if(attempt===1)throw Object.assign(new Error('duplicate'),{code:11000});
      return original();
    }},
  });
  assert.deepEqual(await f.invoke(),{confirmed:true});
  assert.equal(attempt,2);
});

test('failed and expired hold can be recovered for staff approval',async()=>{
  const f=approvalFixture(original({status:'failed', failureReason:'Hold expired'}));
  assert.deepEqual(await f.invoke(),{confirmed:true});
});

test('a changed appointment cannot be silently claimed',async()=>{
  const f=approvalFixture(original(),{Appointment:{async findOneAndUpdate(){ return null; }}});
  await assert.rejects(()=>f.invoke(),error=>error.statusCode===409&&/changed/.test(error.message));
});

test('approval lease contention remains a conflict, not automatic approval',async()=>{
  const f=approvalFixture(original(),{withDistributedLease:async()=>({acquired:false})});
  await assert.rejects(()=>f.invoke(),error=>error.statusCode===409);
});

test('unexpected database claim error is not converted into duplicate-key retry',async()=>{
  const error=new Error('database unavailable');
  const f=approvalFixture(original(),{Appointment:{async findOneAndUpdate(){throw error;}}});
  await assert.rejects(()=>f.invoke(),e=>e===error);
});

function rescheduleFixture(a=original({status:'confirmed'}), replacement=null, overrides={}) {
  const events=[];
  const deps={
    Appointment:{async findOne(query){events.push(['lookup',query]);return replacement;}},
    InterventionService:{create:async()=>{},integrationFailure:async()=>{}},
    Lead:{updateOne:async()=>{}},
    SchedulingProviderFactory:{getProvider:()=>({updateAppointment:async()=>({provider:'internal'})})},
    SocketService:{emitToBusiness:()=>{},emitDashboardRefresh:()=>{}},
    addMinutes:(date,min)=>new Date(+new Date(date)+min*60000),
    assertTransition:()=>events.push(['transition']),
    cancelAppointmentNotifications:async()=>{},
    createHold:async()=>{throw new Error('must not create hold in replay test');},
    crypto:{randomUUID:()=>'uuid-test'},
    exactSlotAvailable:async()=>true,
    getAppointmentForBusiness:async()=>a,
    getBookableService:async()=>({_id:'offering-1', durationMinutes:60}),
    lifecycleMarker:()=>({key:'lifecycle_rescheduled'}),
    normalizeAddress:()=>events.push(['normalize']),
    runNonBlockingAppointmentSideEffect:async()=>{},
    scheduleAppointmentReminders:async()=>{},
    tryRepairAppointmentLifecycle:async()=>events.push(['repair']),
    ...overrides,
  };
  const methods=createAppointmentreschedule1Methods(deps);
  const invoke=(input={startAt:'2026-11-14T10:00:00Z',endAt:'2026-11-14T11:00:00Z'},idempotencyKey='reschedule-key')=>
    methods.reschedule({business,appointmentId:'original-1',input,idempotencyKey});
  return {events,invoke};
}

test('reschedule rejects an outdated customer request before mutating provider',async()=>{
  const f=rescheduleFixture(original({status:'confirmed',rescheduleRequest:{id:'correct',status:'pending',startAt:'2026-11-14T10:00:00Z',endAt:'2026-11-14T11:00:00Z'}}));
  await assert.rejects(()=>f.invoke({requestId:'other',startAt:'2026-11-14T10:00:00Z',endAt:'2026-11-14T11:00:00Z'}),e=>e.statusCode===409);
});

test('reschedule protects idempotency key from collision with a different appointment',async()=>{
  const f=rescheduleFixture(original({status:'confirmed'}),original({rescheduledFrom:'other-appointment'}));
  await assert.rejects(()=>f.invoke(),e=>e.code==='RESCHEDULE_IDEMPOTENCY_CONFLICT');
});

test('reschedule refuses completed failed-state replay',async()=>{
  const f=rescheduleFixture(original({status:'confirmed'}),original({status:'canceled',rescheduledFrom:'original-1'}));
  await assert.rejects(()=>f.invoke(),e=>e.code==='RESCHEDULE_IDEMPOTENCY_FINAL_STATE');
});

test('reschedule refuses an orphaned original with no replacement record',async()=>{
  const f=rescheduleFixture(original({status:'rescheduled',rescheduledTo:null}),null);
  await assert.rejects(()=>f.invoke(),e=>e.code==='RESCHEDULE_REPLACEMENT_NOT_FOUND');
});

test('reschedule same-key replay returns recorded replacement without provider mutation',async()=>{
  const old=original({status:'rescheduled',rescheduledTo:'replacement-id'});
  const confirmed=original({_id:'replacement-id',status:'confirmed',rescheduledFrom:'original-1'});
  const f=rescheduleFixture(old, confirmed);
  assert.equal(await f.invoke(),confirmed);
  assert.ok(f.events.some(x=>x[0]==='repair'));
});

test('reschedule validates updated address before performing lookup',async()=>{
  const f=rescheduleFixture(original({status:'confirmed'}),original({status:'canceled',rescheduledFrom:'original-1'}));
  await assert.rejects(()=>f.invoke({address:'123 Main St', startAt:'2026-11-14T10:00:00Z',endAt:'2026-11-14T11:00:00Z'}));
  assert.ok(f.events.some(x=>x[0]==='normalize'));
});
