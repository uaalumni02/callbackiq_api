import Db from '../../src/db/db.js';
import CallLog from '../../src/controllers/callLog.js';
import Lead from '../../src/controllers/lead.js';
import Conversation from '../../src/controllers/conversation.js';
import Message from '../../src/controllers/message.js';
import ConversationModel from '../../src/models/conversation.js';
import errorHandler from '../../src/middleware/error-handler.js';
import callValidator from '../../src/validator/callLog.js';
import leadValidator from '../../src/validator/lead.js';
import conversationValidator from '../../src/validator/conversation.js';
import { safeConsole } from '../../src/helpers/logging/safeLogger.js';
const id = '507f1f77bcf86cd799439011';
const req = () => ({user:{userId:id},params:{id,conversationId:id},query:{},body:{status:'new',customerPhone:'+14045550123'}});
const response = () => { const res={}; for(const key of ['status','set','json'])res[key]=jest.fn(()=>res);return res;};
beforeEach(()=>{
  for(const validator of [callValidator,leadValidator,conversationValidator])jest.spyOn(validator,'validateAsync').mockResolvedValue({});
  jest.spyOn(safeConsole,'error').mockImplementation(()=>{});
});
afterEach(()=>jest.restoreAllMocks());
const cases=[
 ...['createCallLog','getMyCallLogs','getMyCallLogsOverview','getCallLogById','updateCallLog','deleteCallLog'].map(name=>[CallLog,name]),
 ...['createLead','getMyLeads','getMyLeadsOverview','getLeadById','updateLead','updateLeadStatus','deleteLead'].map(name=>[Lead,name]),
 ...['createConversation','getMyConversations','getConversationById','updateConversation','archiveConversation','restoreConversation','deleteConversation'].map(name=>[Conversation,name]),
 ...['getMessagesByConversation','getMessageById','deleteMessage'].map(name=>[Message,name]),
];
for(const [controller,name] of cases)for(const timeout of [true,false])test(`${name}: ${timeout?'database deadline gives retryable 503':'ordinary failure stays server error'}`,async()=>{
 const error=Object.assign(new Error('database unavailable'),timeout?{code:50}:{});
 jest.spyOn(Db,'getBusinessScopeByOwner').mockRejectedValue(error);
 if(controller===Conversation && !['createConversation','getMyConversations'].includes(name))jest.spyOn(Conversation,'getAuthorizedConversation').mockRejectedValue(error);
 const res=response();await controller[name](req(),res);
 expect(res.status).toHaveBeenCalledWith(timeout?503:500);
 if(timeout){expect(res.set).toHaveBeenCalledWith('Retry-After','2');expect(res.json).toHaveBeenCalledWith(expect.objectContaining({code:'QUERY_BUDGET_EXCEEDED'}));}
});
test('conversation insert timeout propagates through the helper to its HTTP controller',async()=>{
 jest.spyOn(Db,'getBusinessScopeByOwner').mockResolvedValue({_id:id});
 jest.spyOn(ConversationModel,'findOne').mockReturnValue({sort:async()=>null});
 jest.spyOn(Db,'saveConversation').mockRejectedValue(Object.assign(new Error('deadline'),{code:50}));
 const res=response();await Conversation.createConversation(req(),res);
 expect(res.status).toHaveBeenCalledWith(503);expect(res.set).toHaveBeenCalledWith('Retry-After','2');
});
test.each([{code:50},{codeName:'MaxTimeMSExpired'},{code:'CACHE_REFRESH_BUSY'},{code:'CACHE_LOADER_TIMEOUT'}])('global error handler preserves the retry contract %j',error=>{
 const res=response();errorHandler(error,req(),res,jest.fn());
 expect(res.status).toHaveBeenCalledWith(503);expect(res.set).toHaveBeenCalledWith('Retry-After','2');
});
