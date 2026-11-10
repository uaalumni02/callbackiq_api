/**
 * Installable non-network tests against EXISTING extracted appointment command.
 * Phase B, no production source changes. Only install on audited base commit.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertConfirmationNotPending } from '../src/services/scheduling/appointmentConfirmationIntent.repository.js';
import { createAppointmentconfirm1Methods } from '../src/services/scheduling/commands/confirm-1.js';
import { preservePendingApprovalOnAvailabilityConflict } from '../src/services/scheduling/approvalAvailabilityFailurePolicy.js';

const business = { _id: 'tenant-1' };
function fixture({requiresBusinessApproval=true}={}) {
  const events=[];
  const appointment={
    _id:'appointment-1', status:'held', requiresBusinessApproval,
    approvalDecisionAt:null, heldExpiresAt:new Date(Date.now()+900000),
    bookedBy:'staff',conversation:null,serviceOffering:'offering-1',
    address:{postalCode:'30301'},startAt:new Date('2026-11-12T15:00:00Z'),
    endAt:new Date('2026-11-12T16:00:00Z'),
    async save(){events.push('save');return this;},
  };
  let available=false;
  const deps={
    assertConfirmationNotPending, assertIntakeHoldCurrent: async () => {},
    getAppointmentForBusiness:async (tenant,appt)=>{
      assert.equal(tenant,'tenant-1');assert.equal(appt,'appointment-1');
      events.push('load');return appointment;
    },
    assertTransition:()=>events.push('transition'),
    exactSlotAvailable:async()=>{events.push('availability');return available;},
    preservePendingApprovalOnAvailabilityConflict: a=>{
      events.push('approval-preservation-check');
      return preservePendingApprovalOnAvailabilityConflict(a);
    },
    // Fail hard if provider calls occur in a rejected availability scenario.
    SchedulingProviderFactory:{getProvider:()=>{throw new Error('Provider must not be called');}},
  };
  const confirm=()=>createAppointmentconfirm1Methods(deps).confirm({business,appointmentId:'appointment-1',approvedBy:'staff-1'});
  return {appointment,events,confirm,setAvailable:x=>{available=x;}};
}

test('real extracted confirm leaves pending staff hold durable and reviewable on changed availability',async()=>{
  const f=fixture({requiresBusinessApproval:true});
  await assert.rejects(f.confirm,e=>e.code==='SLOT_UNAVAILABLE'&&e.statusCode===409);
  assert.deepEqual(f.events,['load','transition','availability','approval-preservation-check']);
  assert.equal(f.appointment.status,'held');
  assert.equal(f.appointment.approvalDecisionAt,null);
});

test('real extracted confirm retains automatic booking failure behavior when approval is not pending',async()=>{
  const f=fixture({requiresBusinessApproval:false});
  await assert.rejects(f.confirm,e=>e.code==='SLOT_UNAVAILABLE'&&e.statusCode===409);
  assert.deepEqual(f.events,['load','transition','availability','approval-preservation-check','save']);
  assert.equal(f.appointment.status,'failed');
  assert.equal(f.appointment.activeSlotKey,null);
  assert.equal(f.appointment.capacityLane,null);
});

test('availability guard is business-scope checked before any provider operation',async()=>{
  const f=fixture();
  await assert.rejects(f.confirm,e=>e.code==='SLOT_UNAVAILABLE');
  assert.equal(f.events.filter(x=>x==='load').length,1);
  assert.ok(f.events.indexOf('load')<f.events.indexOf('availability'));
});
