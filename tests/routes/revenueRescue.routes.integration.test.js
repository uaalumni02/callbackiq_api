/**
 * MeekCall Revenue Rescue V1 integration certification.
 * Runs against mongodb-memory-server, not production MongoDB, Twilio, Stripe, or Render.
 */
import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import revenueRescueRoutes from '../../src/routes/revenueRescue.routes.js';
import Token from '../../src/helpers/jwt/token.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
import User from '../../src/models/user.js';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import Appointment from '../../src/models/appointment.js';
import Lead from '../../src/models/lead.js';
import ConversionEvent from '../../src/models/conversionEvent.js';
import RevenueRescueOpportunity from '../../src/models/revenueRescueOpportunity.js';

const app = express();
app.use(express.json());
app.use('/api/revenue-rescue', revenueRescueRoutes);
app.use((error, req, res, next) => {
  res.status(error.statusCode || 500).json({ success: false, message: error.message });
});
const oid = () => new mongoose.Types.ObjectId();
const types = [
  'missed_call', 'unsold_estimate', 'abandoned_booking',
  'customer_reactivation', 'cancellation_capacity', 'unpaid_invoice',
];
let businessA, businessB, tokenA, tokenB;
const route = '/api/revenue-rescue';
const as = (token, method, path) => request(app)[method](`${route}${path}`).set('Authorization', `Bearer ${token}`);
const create = (token = tokenA, fields = {}) => as(token, 'post', '/opportunities').send({
  type: 'unsold_estimate', title: 'Test repair estimate', externalKey: 'estimate-101',
  estimatedDollars: '345.67', ...fields,
});
const doAction = (id, action, payload = {}, token = tokenA) =>
  as(token, 'post', `/opportunities/${id}/action`).send({action, ...payload});

beforeAll(async () => { await connectTestDB(); }, 120000);
afterEach(async () => { await clearTestDB(); });
afterAll(async () => { await closeTestDB(); });
beforeEach(async () => {
  const alice = oid(); const bob = oid();
  businessA = oid(); businessB = oid();
  for (const [userId, business, label] of [[alice,businessA,'Alice'],[bob,businessB,'Bob']]) {
    await User.collection.insertOne({
      _id:userId, userName: label, email:`${label.toLowerCase()}@example.com`,
      role:'owner', password:'not-a-real-password', sessionVersion:0,
      termsAccepted:true, privacyAccepted:true,
    });
    await Business.collection.insertOne({
      _id:business, owner:userId, businessName:`${label} Test Plumbing`,
      businessType:'plumbing', isActive:true,
      features:{missedCallSmsEnabled:true,voiceAiEnabled:false,revenueRescueEnabled:true},
      trackingNumber:{status:'active'},
    });
    await Subscription.collection.insertOne({
      business, plan:'pro', status:'active',isActive:true,
      stripeSubscriptionId:`sub_${label.toLowerCase()}_test`,
      priceMonthly:99,lastPaymentStatus:'paid',
    });
  }
  tokenA = Token.sign({userId:String(alice),role:'owner',sessionVersion:0});
  tokenB = Token.sign({userId:String(bob),role:'owner',sessionVersion:0});
});

test('authentication and subscription required; catalog explicitly disables outbound automation',async()=>{
  const noAuth = await request(app).get(`${route}/catalog`);
  expect(noAuth.status).toBe(401);
  const catalog = await as(tokenA,'get','/catalog');
  expect(catalog.status).toBe(200);
  expect(catalog.body.data.types).toEqual(types);
  expect(catalog.body.data.outboundAutomationEnabled).toBe(false);
  await Subscription.deleteOne({business:businessB});
  const unpaid = await as(tokenB,'get','/catalog');
  expect(unpaid.status).toBe(403);
});

test('all six recovery categories import with stable deduplication and no inferred consent',async()=>{
  const rows=types.map((type,i)=>({type,externalKey:`test-import-${i}`,title:`Test ${type}`,estimatedDollars:'5.20'}));
  const first=await as(tokenA,'post','/import').send({rows});
  expect(first.status).toBe(200);
  expect(first.body.data).toMatchObject({created:6,duplicates:0,processed:6});
  const second=await as(tokenA,'post','/import').send({rows});
  expect(second.status).toBe(200);
  expect(second.body.data).toMatchObject({created:0,duplicates:6});
  const list=await as(tokenA,'get','/opportunities?limit=10');
  expect(list.status).toBe(200);
  expect(list.body.data).toHaveLength(6);
  expect(list.body.data.every(x=>x.contactPermission==='unknown')).toBe(true);
  expect(list.body.data.every(x=>x.estimatedCents===520)).toBe(true);
  expect((await RevenueRescueOpportunity.countDocuments({business:businessA}))).toBe(6);
});

test('cross-business read, action and explicit business selection are rejected',async()=>{
  const one=await create(tokenA);
  expect(one.status).toBe(201);
  const id=one.body.data._id;
  expect((await as(tokenB,'get',`/opportunities/${id}`)).status).toBe(404);
  expect((await doAction(id,'claim',{},tokenB)).status).toBe(404);
  const override=await as(tokenA,'get',`/opportunities?businessId=${businessB}`);
  expect(override.status).toBe(404);
  const listB=await as(tokenB,'get','/opportunities');
  expect(listB.body.data).toHaveLength(0);
});

test('cross-business linked lead and appointment IDs cannot be attached',async()=>{
  const foreignLead=oid();
  const foreignAppointment=oid();
  await Lead.collection.insertOne({_id:foreignLead,business:businessB,phone:'+14045550101',serviceNeeded:'Leak'});
  await Appointment.collection.insertOne({_id:foreignAppointment,business:businessB,
    customerPhone:'+14045550101',startAt:new Date('2026-12-01T17:00:00Z'),endAt:new Date('2026-12-01T18:00:00Z')});
  const leadAttempt=await create(tokenA,{externalKey:'foreign-lead',lead:String(foreignLead)});
  expect(leadAttempt.status).toBe(404);
  const appointmentAttempt=await create(tokenA,{externalKey:'foreign-appointment',appointment:String(foreignAppointment)});
  expect(appointmentAttempt.status).toBe(404);
  expect(await RevenueRescueOpportunity.countDocuments({business:businessA})).toBe(0);
});

test('state machine blocks skipping steps and separates owner-reported payments',async()=>{
  const r=await create();
  expect(r.status).toBe(201);
  const id=r.body.data._id;
  const invalid=await doAction(id,'payment_recorded',{paidDollars:'345.67',paymentEvidence:'test ref'});
  expect(invalid.status).toBe(400);
  const claim=await doAction(id,'claim',{assignee:'Front Desk'});
  expect(claim.status).toBe(200);
  expect(claim.body.data.status).toBe('claimed');
  expect((await doAction(id,'contacted')).status).toBe(200);
  const booked=await doAction(id,'booked',{bookedDollars:'300.00'});
  expect(booked.status).toBe(200);
  expect(booked.body.data.bookedCents).toBe(30000);
  expect((await doAction(id,'completed')).status).toBe(200);
  const recorded=await doAction(id,'payment_recorded',{paidDollars:'299.99',paymentEvidence:'manual receipt test-123'});
  expect(recorded.status).toBe(200);
  expect(recorded.body.data.paymentRecordedCents).toBe(29999);
  expect(recorded.body.data.paymentEvidenceSource).toBe('owner_reported');
  expect(recorded.body.data.suggestedAction.kind).toBe('none');
  expect((await doAction(id,'claim')).status).toBe(400);
  const persisted=await RevenueRescueOpportunity.findOne({business:businessA,_id:id});
  expect(persisted.history.map(e=>e.action)).toEqual(['created','claim','contacted','booked','completed','payment_recorded']);
  const summary=await as(tokenA,'get','/summary');
  expect(summary.status).toBe(200);
  expect(summary.body.data.paymentRecordedCents).toBe(29999);
  expect(summary.body.data.important).toMatch(/owner-reported/i);
});

test('invalid inputs, oversized import and missing close reason are rejected',async()=>{
  expect((await create(tokenA,{type:'not_a_type',externalKey:'bad-type'})).status).toBe(400);
  expect((await create(tokenA,{externalKey:'bad-money',estimatedDollars:'1.234'})).status).toBe(400);
  expect((await as(tokenA,'post','/import').send({rows:Array.from({length:51},(_,i)=>({type:'missed_call',externalKey:`k${i}`,title:'Test'}))})).status).toBe(400);
  const made=await create();
  expect(made.status).toBe(201);
  expect((await doAction(made.body.data._id,'close')).status).toBe(400);
  expect((await doAction(made.body.data._id,'suppress_contact')).status).toBe(200);
  const doc=await RevenueRescueOpportunity.findById(made.body.data._id);
  expect(doc.contactPermission).toBe('opted_out');
});

test('conversion sync is bounded, repeatable, tenant-scoped, and does not authorize messaging',async()=>{
  const leadId=oid();
  await Lead.collection.insertOne({
    _id:leadId,business:businessA,phone:'+14045550122',customerName:'Test Customer',
    serviceNeeded:'Drain repair',status:'new',estimatedValue:175,
  });
  await ConversionEvent.collection.insertOne({
    _id:oid(),business:businessA,lead:leadId,type:'missed_call',
    channel:'voice',occurredAt:new Date('2026-10-01T15:00:00Z'),
  });
  const first=await as(tokenA,'post','/sync-conversions').send({});
  expect(first.status).toBe(200);
  expect(first.body.data.created).toBe(1);
  expect(first.body.data.warning).toMatch(/no outbound messages/i);
  const repeat=await as(tokenA,'post','/sync-conversions').send({});
  expect(repeat.status).toBe(200);
  expect(repeat.body.data).toMatchObject({created:0,duplicates:1});
  const doc=await RevenueRescueOpportunity.findOne({business:businessA,type:'missed_call'});
  expect(doc.estimatedCents).toBe(17500);
  expect(doc.contactPermission).toBe('unknown');
  expect((await as(tokenB,'get','/opportunities')).body.data).toHaveLength(0);
});
