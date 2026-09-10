import { recordCallAnswer } from '../../src/services/callAnswerEvidence.service.js';
import CallLog from '../../src/models/callLog.js';
import SocketService from '../../src/services/socket.service.js';
jest.mock('../../src/models/callLog.js',()=>({__esModule:true,default:{findOneAndUpdate:jest.fn()}}));
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:{emitCallUpdated:jest.fn()}}));
beforeEach(()=>jest.clearAllMocks());
test('AI evidence is tenant scoped and never downgrades accepted staff ownership',async()=>{
 await recordCallAnswer({ businessId:'b',callLogId:'c',answeredBy:'ai' });
 const [filter,update]=CallLog.findOneAndUpdate.mock.calls[0];
 expect(filter).toEqual({_id:'c',business:'b',disposition:{$ne:'answered_by_business'}});
 expect(update.$set).toEqual({disposition:'answered_by_ai'});
});
test('accepted staff answer updates legacy status and explicit disposition',async()=>{
 const now=new Date(); CallLog.findOneAndUpdate.mockResolvedValue({_id:'c'});
 await recordCallAnswer({businessId:'b',callLogId:'c',answeredBy:'business',now});
 expect(CallLog.findOneAndUpdate.mock.calls[0][1].$set).toEqual({status:'answered',disposition:'answered_by_business',answeredAt:now});
 expect(SocketService.emitCallUpdated).toHaveBeenCalledWith('b',{_id:'c'});
});
