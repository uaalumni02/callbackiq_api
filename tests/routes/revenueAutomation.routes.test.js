import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import routes from '../../src/routes/revenueAutomation.routes.js';
import Token from '../../src/helpers/jwt/token.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
import Business from '../../src/models/business.js';
import User from '../../src/models/user.js';
import Subscription from '../../src/models/subscription.js';
import InternalRevenueRecord from '../../src/models/internalRevenueRecord.js';
import RevenueAutomationCampaign from '../../src/models/revenueAutomationCampaign.js';
const app=express();app.use(express.json());app.use('/api/revenue-automation',routes);
const id=()=>new mongoose.Types.ObjectId();let ownerA,ownerB,bizA,bizB,tokenA,tokenB;
beforeAll(connectTestDB,120000);afterEach(clearTestDB);afterAll(closeTestDB);
beforeEach(async()=>{
 [ownerA,ownerB,bizA,bizB]=[id(),id(),id(),id()];
 await User.collection.insertMany([
  {_id:ownerA,email:'a@example.com',userName:'owner-a',role:'owner',password:'x',sessionVersion:0},
  {_id:ownerB,email:'b@example.com',userName:'owner-b',role:'owner',password:'x',sessionVersion:0},
 ]);
 await Business.collection.insertMany([
  {_id:bizA,owner:ownerA,businessName:'Plumbing A',businessType:'plumbing',isActive:true,phone:'+16785550100'},
  {_id:bizB,owner:ownerB,businessName:'Plumbing B',businessType:'plumbing',isActive:true,phone:'+16785550101'},
 ]);
 await Subscription.collection.insertMany([{
  business:bizA,plan:'pro',status:'active',isActive:true,stripeSubscriptionId:'sub_a',priceMonthly:99,
 },{business:bizB,plan:'pro',status:'active',isActive:true,stripeSubscriptionId:'sub_b',priceMonthly:99}]);
 tokenA=Token.sign({userId:String(ownerA),role:'owner',sessionVersion:0});tokenB=Token.sign({userId:String(ownerB),role:'owner',sessionVersion:0});
});
const url='/api/revenue-automation';
const call=(token)=>request(app).get(url+'/records').set('Authorization',`Bearer ${token}`);
test('requires auth and subscription-scoped ownership',async()=>{
 expect((await request(app).get(url+'/records')).status).toBe(401);
 expect((await call(tokenA)).status).toBe(200);
});
test('internal estimates create distinct, tenant-isolated records',async()=>{
 const body={recordType:'estimate',reference:'EST-0001',title:'Water heater replacement',customerName:'Sample',customerPhone:'+16785550123',amountDollars:'1250.00'};
 const a=await request(app).post(url+'/records').set('Authorization',`Bearer ${tokenA}`).send(body);
 expect(a.status).toBe(201);
 expect((await call(tokenA)).body.data).toHaveLength(1);
 expect((await call(tokenB)).body.data).toHaveLength(0);
 expect((await request(app).post(url+'/records').set('Authorization',`Bearer ${tokenA}`).send(body)).status).toBe(409);
 const rec=await InternalRevenueRecord.findById(a.body.data._id).lean();expect(rec.amountCents).toBe(125000);
});
test('auto-creates a draft, not an approved send, when an estimate becomes sent',async()=>{
 const body={recordType:'estimate',reference:'EST-0002',title:'Sump pump',customerPhone:'+16785550123',amountDollars:'480'};
 const a=await request(app).post(url+'/records').set('Authorization',`Bearer ${tokenA}`).send(body);
 const changed=await request(app).patch(url+'/records/'+a.body.data._id).set('Authorization',`Bearer ${tokenA}`).send({status:'sent'});
 expect(changed.status).toBe(200);
 const campaigns=await RevenueAutomationCampaign.find({business:bizA});expect(campaigns).toHaveLength(1);expect(campaigns[0].state).toBe('draft');
});
test('cannot fabricate independent payment verification',async()=>{
 const a=await request(app).post(url+'/records').set('Authorization',`Bearer ${tokenA}`).send({recordType:'invoice',reference:'INV-01',title:'Drain service',amountDollars:'200'});
 const id=a.body.data._id;
 expect((await request(app).patch(url+'/records/'+id).set('Authorization',`Bearer ${tokenA}`).send({status:'paid'})).status).toBe(400);
 expect((await request(app).patch(url+'/records/'+id).set('Authorization',`Bearer ${tokenA}`).send({status:'issued'})).status).toBe(200);
 const paid=await request(app).patch(url+'/records/'+id).set('Authorization',`Bearer ${tokenA}`).send({paidDollars:'200',paymentEvidence:'owner receipt 001',evidenceSource:'provider_verified'});
 expect(paid.status).toBe(200);expect(paid.body.data.evidenceSource).toBe('owner_reported');
});
test('consent requires explicit proof and belongs to one business',async()=>{
 const c={phone:'+16785550123',purpose:'service_reactivation',basis:'documented_transactional_request',evidence:'verbal note',consentAt:'2026-10-01T12:00:00Z',confirmConsentRecorded:true};
 expect((await request(app).post(url+'/consents').set('Authorization',`Bearer ${tokenA}`).send(c)).status).toBe(400);
 const yes=await request(app).post(url+'/consents').set('Authorization',`Bearer ${tokenA}`).send({...c,basis:'express_written'});
 expect(yes.status).toBe(200);
 expect((await request(app).get(url+'/consents').set('Authorization',`Bearer ${tokenB}`)).body.data).toHaveLength(0);
});
