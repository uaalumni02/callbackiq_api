import Alert from '../../src/models/alert.js';
import RevenueRescueOpportunity from '../../src/models/revenueRescueOpportunity.js';
import RevenueAutomationCampaign from '../../src/models/revenueAutomationCampaign.js';
import RevenueAutomationSettings from '../../src/models/revenueAutomationSettings.js';
import { processOneRevenueCampaign } from '../../src/services/revenueAutomationEngine.js';
import { scanRevenueRescueDeadlines } from '../../src/services/revenueHumanRescue.service.js';
import crypto from 'node:crypto';
import request from 'supertest';
import app from '../../src/app.js';
import Business from '../../src/models/business.js';
import User from '../../src/models/user.js';
import AdminActionLog from '../../src/models/adminActionLog.js';
import IntegrationConnection from '../../src/models/integrationConnection.js';
import IntegrationWebhookEvent from '../../src/models/integrationWebhookEvent.js';
import TrackingNumber from '../../src/models/trackingNumber.js';
import Message from '../../src/models/message.js';
import Conversation from '../../src/models/conversation.js';
import AttributionTouch from '../../src/models/attributionTouch.js';
import Token from '../../src/helpers/jwt/token.js';
import { getBusinessFeatures } from '../../src/helpers/businessFeatures.js';
import { runIntegrationMaintenance } from '../../src/workers/integrationMaintenance.worker.js';
import { processIntegrationWebhookEvent } from '../../src/workers/integrationWebhook.worker.js';
import { signedTwilioPost } from '../helpers/signTwilioRequest.js';
import { stabilizationFixture } from '../setup/stabilizationFixture.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';

beforeAll(connectTestDB, 60000);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDB(); });
afterAll(closeTestDB);
const paths = [
  ['revenueRescueEnabled', '/api/revenue-rescue/catalog'],
  ['revenueAutomationEnabled', '/api/revenue-automation/catalog'],
  ['conversationIntelligenceEnabled', '/api/conversation-intelligence'],
  ['marketingAttributionEnabled', '/api/marketing-sources'],
  ['marketingAttributionEnabled', '/api/analytics/revenue-recovery/sources'],
  ['jobberEnabled', '/api/integrations/jobber/status'],
];

test.each(paths)('%s gates %s and enforces the pilot allowlist', async (feature, path) => {
  const { business, token } = await stabilizationFixture();
  const call = () => request(app).get(path).set('Authorization', `Bearer ${token}`);
  const off = await call();
  expect(off.status).toBe(404);
  expect(off.body).toEqual({success:false, message:'Not found'});
  await Business.updateOne({_id:business._id}, {$set:{[`features.${feature}`]:true}});
  expect((await call()).status).toBe(feature === 'jobberEnabled' ? 404 : 200);
});
test('legacy records merge all five new flags as false and expose them to owners', async () => {
  const { business, token } = await stabilizationFixture();
  await Business.collection.updateOne({_id:business._id},{$unset:{features:''}});
  const flags = getBusinessFeatures(await Business.collection.findOne({_id:business._id}));
  for (const name of new Set(paths.map(([name])=>name))) expect(flags[name]).toBe(false);
  const response = await request(app).get('/api/businesses/mine').set('Authorization',`Bearer ${token}`);
  expect(response.status).toBe(200);
  expect(response.body.data.features).toEqual(flags);
});
test('Jobber writes are hidden while Google status stays available', async () => {
  const { token } = await stabilizationFixture();
  for (const path of ['connect','disconnect','test','settings','sync-pending']) {
    const method = path === 'connect' ? 'get' : path === 'settings' ? 'put' : 'post';
    expect((await request(app)[method](`/api/integrations/jobber/${path}`).set('Authorization',`Bearer ${token}`).send({})).status).toBe(404);
  }
  expect((await request(app).get('/api/integrations/google/status').set('Authorization',`Bearer ${token}`)).status).toBe(200);
});
test('Jobber authenticates then acknowledges and drops disabled-business ingress', async () => {
  const { business } = await stabilizationFixture();
  await IntegrationConnection.create({ business:business._id, provider:'jobber', providerAccountId:'account-1', status:'connected' });
  const payload={data:{webHookEvent:{accountId:'account-1',topic:'CLIENT_UPDATE',itemId:'client-1'}}};
  const body=JSON.stringify(payload), secret='synthetic-jobber-secret';
  process.env.JOBBER_CLIENT_SECRET=secret;
  const call=()=>request(app).post('/api/integration-webhooks/jobber').type('application/json');
  expect((await call().send(body)).status).toBe(401);
  const headers={'x-jobber-hmac-sha256':crypto.createHmac('sha256',secret).update(body).digest('base64')};
  expect((await call().set(headers).send(body)).status).toBe(202);
  expect(await IntegrationWebhookEvent.countDocuments()).toBe(0);
  await Business.updateOne({_id:business._id},{$set:{'features.jobberEnabled':true}});
  expect((await call().set(headers).send(body)).status).toBe(202);
  expect(await IntegrationWebhookEvent.countDocuments()).toBe(0);
  // Allow the existing immediate drain to finish before clearing the database.
  await new Promise(resolve=>setTimeout(resolve,40));
});
test('maintenance and queued webhooks skip a disabled Jobber business', async () => {
  const { business } = await stabilizationFixture();
  const connection=await IntegrationConnection.create({business:business._id,provider:'jobber',providerAccountId:'account-2',status:'connected',metadata:{jobber:{settings:{syncQualifiedLeads:true}}}});
  const event=await IntegrationWebhookEvent.create({provider:'jobber',eventKey:'disabled-queue',payload:{webHookEvent:{accountId:'account-2',topic:'CLIENT_UPDATE',itemId:'client-2'}}});
  expect((await processIntegrationWebhookEvent(event._id)).status).toBe('ignored');
  const summary=await runIntegrationMaintenance();
  expect(summary.jobberBusinesses).toBe(0);
  expect((await IntegrationConnection.findById(connection._id)).lastSuccessfulSyncAt).toBeNull();
});
test('signed tracking-number SMS persists and preserves its reply number with attribution off', async () => {
  const { business, conversation, lead } = await stabilizationFixture();
  await Business.updateOne({_id:business._id},{$set:{phone:'+14045550200','trackingNumber.status':'active'}});
  const number=await TrackingNumber.create({business:business._id,phoneNumber:'+14045550201',status:'active',smsEnabled:true,smsReady:true,senderAttached:true});
  await Conversation.updateOne({_id:conversation._id},{$set:{humanTakeover:true,aiEnabled:false}});
  const response=await signedTwilioPost(app,'/api/twilio/sms',{From:lead.phone,To:number.phoneNumber,Body:'Please use the side door',MessageSid:'SM_PILOT_FLAGS_ROUTING'});
  expect(response.status).toBe(200);
  expect(await Message.countDocuments({business:business._id,direction:'inbound'})).toBe(1);
  const stored=await Conversation.findById(conversation._id);
  expect(stored.replyFromPhone).toBe(number.phoneNumber);
  expect(stored.latestTrackingNumber).toBeNull();
  expect(await AttributionTouch.countDocuments()).toBe(0);
});
test('only an administrator with fresh MFA can toggle known boolean features, with an audit trail', async () => {
  const { business, token, user }=await stabilizationFixture();
  const path=`/api/admin/businesses/${business._id}/features`;
  const call=(auth,features)=>request(app).patch(path).set('Authorization',`Bearer ${auth}`).send({features});
  expect((await call(token,{jobberEnabled:true})).status).toBe(403);
  await User.updateOne({_id:user._id},{$set:{role:'admin'}});
  const admin=age=>Token.sign({userId:String(user._id),role:'admin',sessionVersion:0,mfaVerified:true,authTime:Math.floor(Date.now()/1000)-age});
  expect((await call(admin(901),{jobberEnabled:true})).status).toBe(401);
  expect((await call(admin(0),{jobberEnabled:'true'})).status).toBe(400);
  expect((await call(admin(0),{unknown:true})).status).toBe(400);
  expect((await call(admin(0),{jobberEnabled:true})).status).toBe(403);
  const features=Object.fromEntries([...new Set(paths.map(([name])=>name))].filter(name=>name!=='jobberEnabled').map(name=>[name,true]));
  const response=await call(admin(0),features);
  expect(response.status).toBe(200);
  expect(response.body.data.features).toMatchObject(features);
  expect(await AdminActionLog.findOne({targetBusiness:business._id,action:'update_business_features'}).lean()).toMatchObject({metadata:{features}});
  // Administrator reads keep their existing explicit-business behavior.
  expect((await request(app).get(`/api/revenue-rescue/catalog?businessId=${business._id}`).set('Authorization',`Bearer ${admin(0)}`)).status).toBe(200);
});

test('revenue ticks leave disabled businesses untouched and rescue resumes after enabling', async () => {
  const {business}=await stabilizationFixture();
  const dueAt=new Date(Date.now()-60000);
  const opportunity=await RevenueRescueOpportunity.create({business:business._id,type:'unpaid_invoice',title:'Synthetic overdue invoice',dueAt});
  await RevenueAutomationSettings.create({business:business._id,enabled:true});
  const campaign=await RevenueAutomationCampaign.collection.insertOne({business:business._id,state:'scheduled',executeAt:dueAt,lockUntil:null});
  const transport=jest.fn();
  const original=process.env.MEEKCALL_REVENUE_AUTOMATION_SEND_ENABLED;
  try {
    process.env.MEEKCALL_REVENUE_AUTOMATION_SEND_ENABLED='true';
    expect(await processOneRevenueCampaign({transport})).toBeNull();
    expect(transport).not.toHaveBeenCalled();
    expect((await RevenueAutomationCampaign.findById(campaign.insertedId)).state).toBe('scheduled');
    expect(await scanRevenueRescueDeadlines()).toEqual({scanned:0,created:0});
    expect(await Alert.countDocuments()).toBe(0);
    await Business.updateOne({_id:business._id},{$set:{'features.revenueRescueEnabled':true}});
    expect(await scanRevenueRescueDeadlines()).toEqual({scanned:1,created:1});
    expect(await Alert.countDocuments({'metadata.revenueRescueOpportunityId':String(opportunity._id)})).toBe(1);
  } finally {
    if(original===undefined)delete process.env.MEEKCALL_REVENUE_AUTOMATION_SEND_ENABLED;
    else process.env.MEEKCALL_REVENUE_AUTOMATION_SEND_ENABLED=original;
  }
});
