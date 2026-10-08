import mongoose from 'mongoose';
import Business from '../../src/models/business.js';
import Lead from '../../src/models/lead.js';
import Alert from '../../src/models/alert.js';
import WebhookEvent from '../../src/models/webhookEvent.js';
import AlertService from '../../src/services/alert.service.js';
import {readFreshFollowUpSettings} from '../../src/services/database/followUpSettingsRead.js';
import {heartbeatTwilioWebhookEvent} from '../../src/services/webhooks/twilioWebhookEvent.service.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
beforeAll(connectTestDB,60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
const id=()=>new mongoose.Types.ObjectId();

test('fresh batched settings keep tenants separate and observe a later settings change',async()=>{
 const a=id(),b=id(),missing=id();
 await Business.collection.insertMany([{_id:a,features:{automatedFollowUpEnabled:true}},{_id:b,features:{automatedFollowUpEnabled:false}}]);
 const rows=await Promise.all([a,b,missing].map(readFreshFollowUpSettings));
 expect(rows.map(row=>row?.features.automatedFollowUpEnabled??null)).toEqual([true,false,null]);
 await Business.updateOne({_id:a},{$set:{'features.automatedFollowUpEnabled':false}});
 expect((await readFreshFollowUpSettings(a)).features.automatedFollowUpEnabled).toBe(false);
});

test('bulk heartbeat cannot renew a different lease owner or a completed event',async()=>{
 const a=id(),b=id(),c=id(),old=new Date(Date.now()-60000);
 await WebhookEvent.collection.insertMany([
  {_id:a,business:id(),eventKey:'a',status:'processing',leaseToken:'a-token',leaseExpiresAt:old},
  {_id:b,business:id(),eventKey:'b',status:'processing',leaseToken:'b-token',leaseExpiresAt:old},
  {_id:c,business:id(),eventKey:'c',status:'completed',leaseToken:'c-token',leaseExpiresAt:old},
 ]);
 await Promise.all([
  heartbeatTwilioWebhookEvent({eventId:a,leaseToken:'a-token'}),
  heartbeatTwilioWebhookEvent({eventId:b,leaseToken:'wrong'}),
  heartbeatTwilioWebhookEvent({eventId:c,leaseToken:'c-token'}),
 ]);
 const rows=await WebhookEvent.find({_id:{$in:[a,b,c]}}).lean();const byId=new Map(rows.map(row=>[String(row._id),row]));
 expect(byId.get(String(a)).leaseExpiresAt.getTime()).toBeGreaterThan(old.getTime());
 expect(byId.get(String(b)).leaseExpiresAt).toEqual(old);
 expect(byId.get(String(c)).leaseExpiresAt).toEqual(old);
});

test('simultaneous alert creation preserves reference identity and durable deduplication across tenants',async()=>{
 await Alert.init();
 const tenants=[{business:id(),lead:id()},{business:id(),lead:id()}];
 await Business.collection.insertMany(tenants.map((t,i)=>({_id:t.business,businessName:`Business ${i}`})));
 await Lead.collection.insertMany(tenants.map((t,i)=>({_id:t.lead,business:t.business,customerName:`Customer ${i}`})));
 const inputs=tenants.map(t=>({businessId:t.business,leadId:t.lead,type:'customer_reply',title:'Reply',message:'Received',dedupeKey:'same-provider-key'}));
 const results=await Promise.all(inputs.map(input=>AlertService.create(input)));
 results.forEach((result,i)=>{
  expect(String(result.alert.business._id)).toBe(String(tenants[i].business));
  expect(String(result.alert.lead._id)).toBe(String(tenants[i].lead));
  expect(result.alert.lead.customerName).toBe(`Customer ${i}`);
 });
 expect(await Alert.countDocuments({})).toBe(2);
 const replay=await AlertService.create(inputs[0]);expect(replay.created).toBe(false);
 expect(String(replay.alert._id)).toBe(String(results[0].alert._id));
 expect(await Alert.countDocuments({})).toBe(2);
});
