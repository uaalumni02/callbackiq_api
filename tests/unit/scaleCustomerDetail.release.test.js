import Controller from '../../src/controllers/customerRecovery.js';
import Business from '../../src/models/business.js';
import Lead from '../../src/models/lead.js';
import { readCustomerDetail, readCustomerHistory } from '../../src/services/scale/customerHistory.service.js';
import { safeConsole } from '../../src/helpers/logging/safeLogger.js';
jest.mock('../../src/services/scale/customerHistory.service.js',()=>({readCustomerDetail:jest.fn(),readCustomerHistory:jest.fn()}));
const id='507f1f77bcf86cd799439011';
const response=()=>{const res={};for(const k of ['status','set','json'])res[k]=jest.fn(()=>res);return res;};
const chain=value=>({maxTimeMS:jest.fn().mockReturnValue({lean:async()=>value})});
const sections=['conversations','messages','calls','appointments','voiceSessions','interventions','intelligence','conversionEvents'];
let business,lead,detail;
beforeEach(()=>{
 business={_id:id,phone:'+14045550100',trackingNumber:{status:'active'}};
 lead={_id:id,business:id,phone:'+14045550101',status:'new'};
 detail={pages:Object.fromEntries(sections.map(s=>[s,{items:[],pagination:{limit:50,hasMore:false,nextCursor:null}}])),summary:{customerLifecycleStatus:'new',appointmentCount:0,confirmedCount:0}};
 jest.spyOn(Business,'findOne').mockImplementation(()=>chain(business));jest.spyOn(Lead,'findOne').mockImplementation(()=>chain(lead));
 jest.spyOn(safeConsole,'error').mockImplementation(()=>{});
 readCustomerDetail.mockImplementation(async()=>detail);readCustomerHistory.mockResolvedValue({items:[],pagination:{hasMore:false}});
});
afterEach(()=>{jest.restoreAllMocks();jest.clearAllMocks();});
const invoke=async extra=>{const res=response();await Controller.getRecoveryDetail({user:{userId:id},params:{leadId:id},query:{},...extra},res);return res;};
test('empty history preserves the bounded envelope and does not write lifecycle state',async()=>{
 const res=await invoke();expect(res.status).toHaveBeenCalledWith(200);
 expect(res.json.mock.calls[0][0].data).toMatchObject({conversation:null,appointment:null,intervention:null,intelligence:null,actions:{canText:true},recovery:{actualRevenue:0,recovered:false}});
 expect(Lead.findOne).toHaveBeenCalledWith({_id:id,business:id});
});
test('section continuation is tenant authorized and forwarded with its cursor',async()=>{
 const query={section:'messages',cursor:'next',limit:'20'};await invoke({query});
 expect(readCustomerHistory).toHaveBeenCalledWith({businessId:id,lead,...query});expect(readCustomerDetail).not.toHaveBeenCalled();
});
test.each([
 ['unauthenticated',()=>{}, {user:undefined},401],['invalid ID',()=>{}, {params:{leadId:'bad'}},400],
 ['missing business',()=>{business=null;},{},404],['wrong-tenant customer',()=>{lead=null;},{},404]
])('%s cannot read history',async(_,setup,request,status)=>{setup();const res=await invoke(request);expect(res.status).toHaveBeenCalledWith(status);expect(readCustomerDetail).not.toHaveBeenCalled();});
test.each([{statusCode:400,message:'Invalid cursor'},{code:50},{codeName:'MaxTimeMSExpired'},new Error('unexpected')])('history failure retains the right status %j',async error=>{
 readCustomerDetail.mockRejectedValue(error);const res=await invoke();expect(res.status).toHaveBeenCalledWith(error.statusCode===400?400:(error.code===50||error.codeName?503:500));
});
test('authoritative older records override the current page and retain all-history revenue',async()=>{
 Object.assign(detail.summary,{appointment:{_id:'old',status:'confirmed'},intervention:{_id:'urgent'},intelligence:{summary:'AI summary'},conversation:{_id:'active'},appointmentCount:8,actualRevenue:275,confirmedCount:1,estimatedRevenue:1000,completed:true,customerLifecycleStatus:'recovered'});
 detail.pages.appointments.items=[{_id:'new',status:'canceled'}];detail.pages.conversations.items=[{_id:'other'}];
 const res=await invoke();const data=res.json.mock.calls[0][0].data;
 expect(data).toMatchObject({appointment:{_id:'old'},conversation:{_id:'active'},intervention:{_id:'urgent'},aiSummary:'AI summary',recovery:{actualRevenue:275,estimatedRevenue:1000,recovered:true}});
});
test.each(['held','confirmed','rescheduled','canceled'])('page fallback retains %s appointment and unresolved intervention',async status=>{
 detail.pages.appointments.items=[{_id:'appointment',status}];
 detail.pages.interventions.items=[{_id:'review',actionRequired:status==='held',resolvedAt:null}];
 detail.pages.intelligence.items=[{summary:'page summary'}];detail.pages.conversations.items=[{id:'conversation'}];
 const data=(await invoke()).json.mock.calls[0][0].data;
 expect(data.appointment._id).toBe('appointment');expect(data.intervention._id).toBe('review');expect(data.aiSummary).toBe('page summary');expect(data.actions.conversationId).toBe('conversation');
});
test.each(['lead-summary','memory-summary','no-phone','no-business-phone','inactive-number','revenue','recovered','completed'])('customer display fallback: %s',async scenario=>{
 if(scenario==='lead-summary')lead.summary='lead';
 if(scenario==='memory-summary')detail.summary.conversation={conversationMemory:{summary:'memory'}};
 if(scenario==='no-phone')delete lead.phone;
 if(scenario==='no-business-phone')delete business.phone;
 if(scenario==='inactive-number')delete business.trackingNumber;
 if(scenario==='revenue')lead.actualRevenue=75;
 if(scenario==='recovered')lead.recovered=true;
 if(scenario==='completed')detail.summary.completed=true;
 const data=(await invoke()).json.mock.calls[0][0].data;
 if(scenario==='lead-summary')expect(data.aiSummary).toBe('lead');
 if(scenario==='memory-summary')expect(data.aiSummary).toBe('memory');
 if(['no-phone','no-business-phone','inactive-number'].includes(scenario))expect(data.actions.canText).toBe(false);
 if(['revenue','recovered','completed'].includes(scenario))expect(data.recovery.recovered).toBe(true);
});
