import Appointment from '../../src/models/appointment.js';
import Job from '../../src/models/appointmentNotificationJob.js';
import Message from '../../src/models/message.js';
import { appointmentPageQuery, listAppointmentPage } from '../../src/services/scheduling/appointmentList.service.js';
import { presentAppointments } from '../../src/services/scheduling/appointmentPresentation.service.js';
import { encodePage } from '../../src/services/scale/queryBudget.js';
const business='64b000000000000000000001';
const id=n=>`64b${String(n).padStart(21,'0')}`;
const query=result=>({sort:jest.fn(()=>query(result)),limit:jest.fn(()=>query(result)),populate:jest.fn(()=>query(result)),select:jest.fn(()=>query(result)),maxTimeMS:jest.fn(()=>query(result)),lean:async()=>result});
afterEach(()=>jest.restoreAllMocks());
test('keyset cursors are tied to tenant and filters and order ties by ID',()=>{
 const first=appointmentPageQuery({businessId:business,query:{view:'all'}});
 const cursor=encodePage({scope:first.scope,at:'2026-10-01T12:00:00Z',id:id(1)});
 const next=appointmentPageQuery({businessId:business,query:{view:'all',cursor}});
 expect(next.filter.business).toBe(business);
 expect(next.filter.$and[0].$or[1]._id.$lt.toString()).toBe(id(1));
 expect(next.direction).toBe(-1);
 expect(()=>appointmentPageQuery({businessId:id(2),query:{view:'all',cursor}})).toThrow(/cursor/);
 expect(()=>appointmentPageQuery({businessId:business,query:{view:'approvals',cursor}})).toThrow(/cursor/);
 expect(()=>appointmentPageQuery({businessId:business,query:{pageSize:101}})).toThrow();
 expect(()=>appointmentPageQuery({businessId:business,query:{cursor:'bad'}})).toThrow();
});
test('upcoming and approvals retain expired undecided holds, without an age cutoff',()=>{
 const result=appointmentPageQuery({businessId:business,query:{view:'approvals'}});
 expect(result.filter.$and[0].$or[0]).toMatchObject({requiresBusinessApproval:true,approvalDecisionAt:null,$or:expect.arrayContaining([{status:'failed',failureReason:/hold expired/i}])});
 expect(JSON.stringify(result.filter)).not.toContain('updatedAt');
});
test('page is bounded, reads one extra record and returns cursor plus global approval count',async()=>{
 const rows=Array.from({length:26},(_,n)=>({_id:id(n),business,status:'confirmed',startAt:new Date('2026-10-01T12:00:00Z')}));
 const chain=query(rows);chain.sort.mockReturnValue(chain);chain.limit.mockReturnValue(chain);
 jest.spyOn(Appointment,'find').mockReturnValue(chain);
 jest.spyOn(Appointment,'countDocuments').mockReturnValue({maxTimeMS:async()=>60});
 jest.spyOn(Job,'find').mockReturnValue(query([]));
 const result=await listAppointmentPage({businessId:business,query:{view:'all'}});
 expect(result.data).toHaveLength(25);expect(result.pagination.hasMore).toBe(true);expect(result.summary.pendingApprovals).toBe(60);
 expect(chain.limit).toHaveBeenCalledWith(26);
 expect(chain.sort).toHaveBeenCalledWith({startAt:-1,_id:-1});
 expect(Job.find).toHaveBeenCalledTimes(1);
 expect(Appointment.countDocuments.mock.calls[0][0].business).toBe(business);
});
test('delivery is linked to the confirmation receipt, never another customer message',async()=>{
 jest.spyOn(Job,'find').mockReturnValue(query([{appointment:id(1),status:'sent',providerMessageId:'SMone'}]));
 jest.spyOn(Message,'find').mockReturnValue(query([{providerMessageId:'SMone',deliveryStatus:'delivered'}]));
 const rows=await presentAppointments([{_id:id(1),status:'confirmed',requiresBusinessApproval:true},{_id:id(2),status:'confirmed',requiresBusinessApproval:true}],business);
 expect(rows[0].confirmationNotice).toMatchObject({status:'sent',deliveryStatus:'delivered'});
 expect(rows[1].confirmationNotice).toMatchObject({status:'missing',deliveryStatus:'unverified'});
 expect(Message.find.mock.calls[0][0]).toMatchObject({business,direction:'outbound',provider:'twilio',providerMessageId:{$in:['SMone']}});
});
test('unavailable delivery evidence cannot turn a successful approval into an API error',async()=>{
 jest.spyOn(Job,'find').mockImplementation(()=>{throw new Error('offline');});
 expect((await presentAppointments([{_id:id(1),status:'confirmed'}],business))[0]).toMatchObject({status:'confirmed',confirmationNoticeStatus:'unavailable'});
});
