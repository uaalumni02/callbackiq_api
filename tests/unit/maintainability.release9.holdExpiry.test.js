import { createExpiredHoldReconciler } from '../../src/services/scheduling/appointmentHoldExpiry.service.js';

const make = () => {
  const order=[];
  const result={matchedCount:2,modifiedCount:2};
  let capturedFilter,capturedUpdate;
  const dependency=(name)=>jest.fn(async ({businessId}={})=>{order.push([name,businessId]);});
  const d={
    Appointment: {updateMany:jest.fn(async (filter,update)=>{
      capturedFilter=filter; capturedUpdate=update; order.push(['updateMany']);return result;
    })},
    reconcileApprovalRequests:dependency('approval'),
    repairPendingAppointmentLifecycles:dependency('lifecycle'),
    repairPendingAppointmentProjections:dependency('projection'),
    repairRescheduleReviews:dependency('reschedule'),
    reconcileAppointmentNoticeFailures:dependency('notices'),
    runApprovalSms:jest.fn(async()=>{order.push(['sms']);}),
  };
  return {d,order,result,filter:()=>capturedFilter,update:()=>capturedUpdate};
};

test('hold expiry retains tenant scope and the exact ordered reconciliation flow',async()=>{
  const {d,order,result,filter,update}=make();
  await expect(createExpiredHoldReconciler(d)('tenant-id')).resolves.toBe(result);
  expect(filter().status).toBe('held');
  expect(filter().business).toBe('tenant-id');
  expect(filter().heldExpiresAt.$lte).toBeInstanceOf(Date);
  expect(update().$set.status).toBe('failed');
  expect(update().$set.slotClaimKeys).toEqual([]);
  expect(order).toEqual([
    ['updateMany'],['approval','tenant-id'],['lifecycle','tenant-id'],
    ['projection','tenant-id'],['reschedule','tenant-id'],['notices','tenant-id'],['sms']
  ]);
});

test('unscoped recovery keeps original global worker semantics',async()=>{
  const {d,filter}=make();
  await createExpiredHoldReconciler(d)();
  expect(filter()).not.toHaveProperty('business');
});

test('failed persistence short-circuits downstream side effects',async()=>{
  const {d,order}=make();
  d.Appointment.updateMany.mockRejectedValue(new Error('db offline'));
  await expect(createExpiredHoldReconciler(d)('tenant-id')).rejects.toThrow('db offline');
  expect(d.reconcileApprovalRequests).not.toHaveBeenCalled();
  expect(order).toHaveLength(0);
});
