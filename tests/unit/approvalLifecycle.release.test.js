import ServiceOffering from '../../src/models/serviceOffering.js';
import Appointment from '../../src/models/appointment.js';
import Alert from '../../src/models/alert.js';
import Business from '../../src/models/business.js';
import Conversation from '../../src/models/conversation.js';
import { reconcileApprovalRequests } from '../../src/services/scheduling/approvalLifecycle.service.js';
import { scheduleAppointmentChangeNotice } from '../../src/services/scheduling/appointmentNotification.service.js';
jest.mock('../../src/models/appointment.js',()=>({__esModule:true,default:{find:jest.fn(),findById:jest.fn(),updateOne:jest.fn()}}));
jest.mock('../../src/models/alert.js',()=>({__esModule:true,default:{findOneAndUpdate:jest.fn(),updateOne:jest.fn(),updateMany:jest.fn()}}));
jest.mock('../../src/models/business.js',()=>({__esModule:true,default:{findById:jest.fn()}}));
jest.mock('../../src/models/conversation.js',()=>({__esModule:true,default:{updateOne:jest.fn()}}));
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:{emitAlertUpdated:jest.fn()}}));
jest.mock('../../src/services/scheduling/appointmentNotification.service.js',()=>({scheduleAppointmentChangeNotice:jest.fn()}));
jest.mock('../../src/models/serviceOffering.js',()=>({__esModule:true,default:{findById:jest.fn()}}));
let request;
beforeEach(()=>{
 jest.clearAllMocks();ServiceOffering.findById.mockResolvedValue({name:'Inspection'});request={_id:'a1',business:'b1',conversation:'c1',requiresBusinessApproval:true,status:'failed',failureReason:'Appointment hold expired before confirmation.',heldExpiresAt:new Date(Date.now()-60000),approvalRecovery:{expiredAt:new Date()}};
 Appointment.find.mockImplementation(()=>({sort:()=>({limit:()=>({lean:async()=>[request]})})}));
 Appointment.findById.mockImplementation(()=>({lean:async()=>request}));Appointment.updateOne.mockResolvedValue({modifiedCount:1});
 Business.findById.mockReturnValue({select:()=>({lean:async()=>({owner:'u1'})})});
 Alert.findOneAndUpdate.mockResolvedValue({_id:'alert1'});Alert.updateOne.mockResolvedValue({});Alert.updateMany.mockResolvedValue({});Conversation.updateOne.mockResolvedValue({});scheduleAppointmentChangeNotice.mockResolvedValue({});
});
test('expired reservation creates an owned actionable review and honest idempotent notice',async()=>{
 expect(await reconcileApprovalRequests()).toEqual({repaired:1});
 expect(Alert.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({actionRequired:true,'metadata.approvalState':'needs_recheck',resolvedAt:null});
 expect(Alert.findOneAndUpdate.mock.calls[0][1].$setOnInsert.assignedTo).toBe('u1');
 expect(scheduleAppointmentChangeNotice).toHaveBeenCalledWith(expect.objectContaining({key:'approval_hold_expired',body:expect.stringContaining('no longer reserved')}));
 expect(Appointment.updateOne.mock.calls[0][1].$set).toMatchObject({'approvalRecovery.reconciled':true,'approvalRecovery.state':'needs_recheck'});
});
test('failed delivery enqueue leaves recovery retryable instead of dropping the request',async()=>{
 scheduleAppointmentChangeNotice.mockRejectedValueOnce(new Error('queue unavailable'));
 expect(await reconcileApprovalRequests()).toEqual({repaired:0});
 expect(Appointment.updateOne.mock.calls[0][1].$set).toEqual({'approvalRecovery.lastError':'queue unavailable'});
 expect(await reconcileApprovalRequests()).toEqual({repaired:1});
});
test('old reservations recovered after an outage do not send stale customer texts',async()=>{
 request.heldExpiresAt=new Date(Date.now()-3*86400000);await reconcileApprovalRequests();expect(scheduleAppointmentChangeNotice).not.toHaveBeenCalled();expect(Alert.findOneAndUpdate).toHaveBeenCalled();
});
test('terminal decision repairs unresolved approval alerts',async()=>{
 request.status='canceled';await reconcileApprovalRequests();expect(Alert.updateMany).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({$set:expect.objectContaining({actionRequired:false,'metadata.approvalState':'canceled'})}));expect(scheduleAppointmentChangeNotice).not.toHaveBeenCalled();
});

test('crash after confirmed save repairs the same notice before resolving recovery',async()=>{
 request.status='confirmed';request.startAt=new Date(Date.now()+86400000);
 expect(await reconcileApprovalRequests()).toEqual({repaired:1});
 expect(scheduleAppointmentChangeNotice).toHaveBeenCalledWith(expect.objectContaining({key:'business_approval_confirmed'}));
 expect(scheduleAppointmentChangeNotice.mock.invocationCallOrder[0]).toBeLessThan(Appointment.updateOne.mock.invocationCallOrder[0]);
 expect(Conversation.updateOne).toHaveBeenCalledWith(expect.objectContaining({business:'b1','bookingState.appointment':'a1'}),expect.anything());
});
test('confirmed notice enqueue failure cannot mark recovery complete',async()=>{
 request.status='confirmed';request.startAt=new Date(Date.now()+86400000);
 scheduleAppointmentChangeNotice.mockRejectedValueOnce(new Error('outbox unavailable'));
 expect(await reconcileApprovalRequests()).toEqual({repaired:0});
 expect(Alert.updateMany).not.toHaveBeenCalled();
 expect(Appointment.updateOne).toHaveBeenCalledWith({_id:'a1'},{$set:{'approvalRecovery.lastError':'outbox unavailable'}});
 expect(await reconcileApprovalRequests()).toEqual({repaired:1});
});
