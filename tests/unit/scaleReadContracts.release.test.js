import mongoose from 'mongoose';
import Conversation from '../../src/models/conversation.js';
import Message from '../../src/models/message.js';
import CallLog from '../../src/models/callLog.js';
import Appointment from '../../src/models/appointment.js';
import VoiceSession from '../../src/models/voiceSession.js';
import Alert from '../../src/models/alert.js';
import Intelligence from '../../src/models/conversationIntelligence.js';
import ConversionEvent from '../../src/models/conversionEvent.js';
import Job from '../../src/models/smsProcessingJob.js';
import {readCustomerDetail,readCustomerHistory,readCustomerSummary} from '../../src/services/scale/customerHistory.service.js';
import {getConversationsPage,getMessagesPage} from '../../src/services/cursorPagination.service.js';
import {claimNextInboundSmsJob} from '../../src/services/messaging/smsProcessingQueue.service.js';
import Owner from '../../src/services/ownerExperience.service.js';
import {queryOwnerOpportunities} from '../../src/services/scale/ownerOpportunityQuery.service.js';
jest.mock('../../src/services/scale/ownerOpportunityQuery.service.js',()=>({queryOwnerOpportunities:jest.fn()}));
const id=new mongoose.Types.ObjectId();const options={businessId:id,lead:{_id:id,status:'new'}};
beforeEach(()=>{
 for(const model of [Conversation,Message,CallLog,Appointment,VoiceSession,Alert,Intelligence,ConversionEvent])jest.spyOn(model,'aggregate').mockReturnValue({option:async()=>[]});
 for(const model of [Conversation,Appointment,Alert])jest.spyOn(model,'populate').mockImplementation(async rows=>rows);
});
afterEach(()=>{jest.restoreAllMocks();jest.clearAllMocks();delete process.env.SMS_CLAIM_MAX_TIME_MS;});
test('all history sections retain pagination and reject unsupported sections',async()=>{
 const result=await readCustomerDetail(options);expect(Object.keys(result.pages)).toHaveLength(8);expect(result.summary.appointmentCount).toBe(0);
 await expect(readCustomerHistory({...options,section:'unknown'})).rejects.toMatchObject({statusCode:400});
});
test('history summary includes old completed revenue and authoritative latest records',async()=>{
 Conversation.aggregate.mockImplementation(p=>({option:async()=>p.at(-1).$group?[{_id:{status:'closed',booking:'booked',engaged:true}},{_id:{status:'open',engaged:false}}]:[{_id:id}]}));
 Appointment.aggregate.mockImplementation(p=>({option:async()=>p.at(-1).$group?[{_id:'completed',count:2,revenue:275},{_id:'confirmed',count:1,estimatedCount:1,estimate:500}]:[{_id:id,status:'confirmed'}]}));
 VoiceSession.aggregate.mockReturnValue({option:async()=>[{_id:{status:'completed',outcome:'booked'}}]});
 Alert.aggregate.mockReturnValue({option:async()=>[{_id:id}]});Intelligence.aggregate.mockReturnValue({option:async()=>[{_id:id}]});
 expect(await readCustomerSummary({...options,lead:{...options.lead,phone:'+14045550123'}})).toMatchObject({appointmentCount:3,actualRevenue:275,confirmedCount:1,estimatedRevenue:500,conversation:{_id:id},intervention:{_id:id}});
});
test('latest messages reverse display order without changing continuation order',async()=>{
 const rows=[{_id:new mongoose.Types.ObjectId(),createdAt:new Date(3)},{_id:new mongoose.Types.ObjectId(),createdAt:new Date(2)},{_id:new mongoose.Types.ObjectId(),createdAt:new Date(1)}];
 Message.aggregate.mockReturnValue({option:async()=>rows});
 const page=await readCustomerHistory({...options,section:'messages',limit:2});expect(page.items).toEqual([rows[1],rows[0]]);expect(page.pagination.hasMore).toBe(true);
});
test('conversation search remains tenant scoped within the joined lead match',async()=>{
 Conversation.aggregate.mockReturnValue({option:async()=>[]});
 await getConversationsPage(String(id),{search:'repair.*',status:'open'});
 const pipeline=Conversation.aggregate.mock.calls[0][0];expect(pipeline[0].$match.business).toEqual(id);
 const search=pipeline.find(p=>p.$match?.$or).$match.$or;expect(search[2].searchLead.$elemMatch.business).toEqual(id);
 expect(search[0].customerName.test('repair.*')).toBe(true);expect(search[0].customerName.test('repair anything')).toBe(false);
});
test('latest message cursor searches older messages and keeps customer conversation context',async()=>{
 const rows=[{_id:id,createdAt:new Date(3)},{_id:id,createdAt:new Date(2)}];
 const chain={};for(const method of ['sort','limit','populate','maxTimeMS'])chain[method]=jest.fn(()=>chain);chain.lean=async()=>rows;
 jest.spyOn(Message,'find').mockReturnValue(chain);
 const conversation={_id:id,customerPhone:'+14045550123'};
 const first=await getMessagesPage(id,{order:'latest',limit:1},{conversation});
 expect(first.items[0].conversation.customerPhone).toBe(conversation.customerPhone);
 await getMessagesPage(id,{order:'latest',limit:1,cursor:first.nextCursor},{conversation});
 expect(Message.find.mock.calls[1][0].$or[0].createdAt.$lt).toEqual(new Date(3));
});
test.each([['10',100],['9000',5000],['invalid',2000]])('queue claim deadline is bounded for %s',async(value,expected)=>{
 process.env.SMS_CLAIM_MAX_TIME_MS=value;jest.spyOn(Job,'findOneAndUpdate').mockResolvedValue(null);
 const businesses=Array.from({length:205},()=>String(new mongoose.Types.ObjectId()));
 await claimNextInboundSmsJob({excludeBusinesses:businesses});const [filter,,config]=Job.findOneAndUpdate.mock.calls[0];
 expect(filter.business.$nin).toHaveLength(200);expect(config.maxTimeMS).toBe(expected);
});
test('owner page preserves records and sorts attention, urgency, then recency',async()=>{
 const row=(n,extra={})=>({_id:String(n),status:'new',_conversation:[],_appointment:[],_interventions:[],...extra});
 const rows=[row(1,{urgency:'low'}),row(2,{urgency:'emergency'}),row(3,{urgency:'unknown'}),row(4,{urgency:'unknown',updatedAt:new Date()}),
 row(5,{_interventions:[{_id:id}]}),row(6,{_conversation:[{_id:id,bookingState:{status:'collecting_service'}}],_appointment:[{_id:id,status:'held'}]})];
 queryOwnerOpportunities.mockResolvedValue({rows,pagination:{hasMore:false}});
 const result=await Owner.opportunities({business:{_id:id,features:{}}});expect(result.items).toHaveLength(rows.length);expect(result.items[0].needsAttention).toBe(true);expect(result.rows).toBeUndefined();
 expect(new Set(result.items.map(x=>x.id)).size).toBe(rows.length);
});
test('phone-linked call history includes both directions without losing the lead scope',async()=>{
 await readCustomerHistory({...options,lead:{...options.lead,phone:'+14045550123'},section:'calls'});
 expect(CallLog.aggregate.mock.calls[0][0][0].$match.$and[0].$or).toEqual([{lead:id},{from:'+14045550123'},{to:'+14045550123'}]);
});
test('owner sort tolerates missing timestamps in tied historical records',async()=>{
 const row=n=>({_id:String(n),status:'new',urgency:'unknown',_conversation:[],_appointment:[],_interventions:[]});
 queryOwnerOpportunities.mockResolvedValue({rows:[row(1),row(2),row(3)]});
 expect((await Owner.opportunities({business:{_id:id,features:{}}})).items.map(x=>x.id)).toEqual(['1','2','3']);
});
