import Alert from '../../src/models/alert.js';
import AlertService from '../../src/services/alert.service.js';
import SocketService from '../../src/services/socket.service.js';
jest.mock('../../src/models/alert.js',()=>({__esModule:true,default:{create:jest.fn(),populate:jest.fn(),findOne:jest.fn(),findById:jest.fn()}}));
jest.mock('../../src/services/requestReview.service.js',()=>({isRequestReview:jest.fn(()=>false),saveRequestReview:jest.fn()}));
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:{emitAlertCreated:jest.fn()}}));
const input={businessId:'b1',leadId:'l1',type:'customer_reply',title:'Reply',message:'Customer reply',dedupeKey:'customer_reply:SM1'};
beforeEach(()=>jest.clearAllMocks());
test('new alert keeps populated return/event without rereading inserted alert',async()=>{
 const raw={_id:'a1',business:'b1',lead:'l1',status:'sent',createdAt:new Date()},populated={...raw,business:{_id:'b1',businessName:'Test'},lead:{_id:'l1',customerName:'Customer'}};
 Alert.create.mockResolvedValue({toObject:()=>raw});Alert.populate.mockResolvedValue(populated);
 expect(await AlertService.create(input)).toEqual({alert:populated,created:true});expect(Alert.findById).not.toHaveBeenCalled();
 expect(Alert.populate).toHaveBeenCalledWith(raw,expect.arrayContaining([expect.objectContaining({path:'business',options:{lean:true}}),expect.objectContaining({path:'lead',options:{lean:true}})]));
 expect(SocketService.emitAlertCreated).toHaveBeenCalledWith('b1',populated);
});
test('duplicate-key replay still reads existing tenant-scoped alert',async()=>{
 Alert.create.mockRejectedValue(Object.assign(new Error('duplicate'),{code:11000}));
 Alert.findOne.mockReturnValue({select:()=>({lean:async()=>({_id:'a1'})})});
 const q={populate:jest.fn().mockReturnThis(),lean:jest.fn().mockResolvedValue({_id:'a1'})};Alert.findById.mockReturnValue(q);
 expect(await AlertService.create(input)).toEqual({alert:{_id:'a1'},created:false});
 expect(Alert.findOne).toHaveBeenCalledWith({business:'b1',dedupeKey:input.dedupeKey});expect(SocketService.emitAlertCreated).not.toHaveBeenCalled();
});
test('strict critical alert still propagates durable creation failure',async()=>{
 const error=new Error('database unavailable');Alert.create.mockRejectedValue(error);
 await expect(AlertService.createCustomerReplyAlert({businessId:'b1',priority:'critical',providerMessageId:'SM1',messageBody:'danger'})).rejects.toBe(error);
 expect(Alert.populate).not.toHaveBeenCalled();
});
test('concurrent alerts share reference reads without swapping tenant results',async()=>{
 const docs=[{_id:'a1',business:'b1',lead:'l1'},{_id:'a2',business:'b2',lead:'l2'}];
 Alert.create.mockImplementation(async payload=>({toObject:()=>docs.find(doc=>doc.business===payload.business)}));
 Alert.populate.mockImplementation(async values=>values.map(doc=>({...doc,business:{_id:doc.business},lead:{_id:doc.lead}})));
 const results=await Promise.all([AlertService.create(input),AlertService.create({...input,businessId:'b2',leadId:'l2',dedupeKey:'second'})]);
 expect(Alert.populate).toHaveBeenCalledTimes(1);
 expect(results.map(r=>r.alert.business._id)).toEqual(['b1','b2']);
 expect(SocketService.emitAlertCreated.mock.calls.map(([business,alert])=>[business,alert.business._id])).toEqual([['b1','b1'],['b2','b2']]);
});
