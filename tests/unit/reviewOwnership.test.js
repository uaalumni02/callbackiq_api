import Alert from '../../src/models/alert.js';
import Conversation from '../../src/models/conversation.js';
import Controller from '../../src/controllers/intervention.js';
import getOwnedBusiness from '../../src/services/businessScope.service.js';
jest.mock('../../src/models/alert.js',()=>({__esModule:true,default:{findOne:jest.fn(),findOneAndUpdate:jest.fn()}}));
jest.mock('../../src/models/conversation.js',()=>({__esModule:true,default:{findOneAndUpdate:jest.fn()}}));
jest.mock('../../src/services/businessScope.service.js',()=>({__esModule:true,default:jest.fn()}));
jest.mock('../../src/services/socket.service.js',()=>({__esModule:true,default:{emitAlertUpdated:jest.fn(),emitConversationUpdated:jest.fn()}}));
const current={_id:'a',conversation:'c',assignedTo:'owner',acknowledgedAt:new Date()};
const chain=value=>{const q={populate:()=>q,then:resolve=>Promise.resolve(value).then(resolve)};return q;};
const req={params:{id:'a'},body:{pauseAutomation:true},user:{userId:'owner'}};
let res,next;
beforeEach(()=>{jest.clearAllMocks();getOwnedBusiness.mockResolvedValue({_id:'b',owner:'owner'});Alert.findOne.mockReturnValue(chain(current));Conversation.findOneAndUpdate.mockResolvedValue({_id:'c',humanTakeover:true,aiEnabled:false});res={status:jest.fn().mockReturnThis(),json:jest.fn()};next=jest.fn();});
test('retry on an acknowledged review completes takeover without changing ownership',async()=>{
 await Controller.acknowledge(req,res,next);
 expect(next).not.toHaveBeenCalled();expect(res.status).toHaveBeenCalledWith(200);
 expect(Alert.findOneAndUpdate).not.toHaveBeenCalled();
 expect(Conversation.findOneAndUpdate).toHaveBeenCalledWith({_id:'c',business:'b'},{$set:{humanTakeover:true,aiEnabled:false}},{returnDocument:'after'});
});
test('a failed pause never reports success or reverses the durable acknowledgment',async()=>{
 Conversation.findOneAndUpdate.mockRejectedValue(new Error('database unavailable'));
 await Controller.acknowledge(req,res,next);
 expect(next).toHaveBeenCalledWith(expect.any(Error));expect(res.json).not.toHaveBeenCalled();expect(Alert.findOneAndUpdate).not.toHaveBeenCalled();
});
test('legacy acknowledgment without takeover does not change automation',async()=>{
 await Controller.acknowledge({...req,body:{}},res,next);
 expect(Conversation.findOneAndUpdate).not.toHaveBeenCalled();expect(res.status).toHaveBeenCalledWith(200);
});
