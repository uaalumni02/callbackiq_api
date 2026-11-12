import http from 'node:http';
import Stripe from 'stripe';
import Subscription from '../../src/models/subscription.js';
import Grant from '../../src/models/trialExtensionGrant.js';
import {extendTrial} from '../../src/services/trialExtension.service.js';
import {getStripeClient} from '../../src/helpers/stripe/stripeClient.js';
import {trackingFixture} from '../fixtures/trackingNumber.fixture.js';
import {connectTestDB,clearTestDB,closeTestDB} from '../setup/testDb.js';
jest.mock('../../src/helpers/stripe/stripeClient.js',()=>({getStripeClient:jest.fn()}));
let server,requests=[];
beforeAll(async()=>{
 await connectTestDB();
 server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=new URLSearchParams(raw);requests.push({path:req.url,method:req.method,body,headers:req.headers});
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({id:'sub_tracking',object:'subscription',status:'trialing',trial_end:Number(body.get('trial_end')),current_period_end:Number(body.get('trial_end'))}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 getStripeClient.mockReturnValue(new Stripe('sk_test_offline_contract',{host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0}));
},60000);
afterEach(async()=>{requests=[];await clearTestDB();delete process.env.TRIAL_MAX_ADMIN_EXTENSION_DAYS;});
afterAll(async()=>{await new Promise(resolve=>server.close(resolve));await closeTestDB();});
test('a trial extension preserves the real Stripe SDK request, idempotency key and persisted grant',async()=>{
 process.env.TRIAL_MAX_ADMIN_EXTENSION_DAYS='14';
 const pair=await trackingFixture(),end=new Date(Date.now()+86400000);
 await Subscription.updateOne({_id:pair.subscription._id},{$set:{status:'trialing',trialUsedAt:new Date(),trialEndsAt:end}});
 const result=await extendTrial({businessId:pair.business._id,adminUserId:pair.business.owner,days:2,reason:'Synthetic recovery',operationKey:'offline-wire-contract'});
 expect(requests).toHaveLength(1);
 expect(requests[0]).toMatchObject({method:'POST',path:'/v1/subscriptions/sub_tracking'});
 expect(Object.fromEntries(requests[0].body)).toEqual({trial_end:String(Math.floor((end.getTime()+2*86400000)/1000)),proration_behavior:'none'});
 expect(requests[0].headers['idempotency-key']).toMatch(/^trial-extension:[a-f0-9]{64}$/);
 expect(result.trialExtensionIntent.status).toBe('applied');
 expect(await Grant.countDocuments({business:pair.business._id,days:2})).toBe(1);
});
