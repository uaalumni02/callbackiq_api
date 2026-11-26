import Attempt from '../../src/models/checkoutAttempt.js';
import { openCheckoutAttempt, retireLegacyCheckout } from '../../src/services/billing/checkoutAttempt.service.js';
import { assertDistributedLeaseActive } from '../../src/services/distributedLease.service.js';
jest.mock('../../src/models/checkoutAttempt.js',()=>({__esModule:true,default:{findOne:jest.fn(),findOneAndUpdate:jest.fn(),updateOne:jest.fn(),exists:jest.fn()}}));
jest.mock('../../src/services/distributedLease.service.js',()=>({assertDistributedLeaseActive:jest.fn()}));
jest.mock('../../src/config/numericSettings.js',()=>({numericSetting:name=>require('../../config/numeric-settings.json')[name].default}));
const query=value=>({select:jest.fn().mockResolvedValue(value)});
const params={line_items:[{price:'price_synthetic_pro',quantity:1}]};
const intent=(extra={})=>({_id:'attempt',business:'tenant',generation:2,purpose:'paid',state:'creating',sessionId:'',attemptStartedAt:new Date(),idempotencyKey:'synthetic-stable-key',params,...extra});
let stripe;
beforeEach(()=>{
 jest.resetAllMocks();
 Attempt.findOne.mockReturnValue(query(null));Attempt.updateOne.mockResolvedValue({matchedCount:1});Attempt.exists.mockResolvedValue(false);
 Attempt.findOneAndUpdate.mockImplementation((_filter,update)=>query({...update.$set,_id:'attempt'}));
 stripe={checkout:{sessions:{retrieve:jest.fn(),expire:jest.fn().mockResolvedValue({status:'expired'}),create:jest.fn().mockResolvedValue({id:'cs_synthetic',url:'https://checkout.example.test/session',status:'open'})}}};
});
const open=()=>openCheckoutAttempt({stripe,businessId:'tenant',purpose:'paid',params});
test.each([null,{}, {id:'cs_synthetic'}, {id:'cs_synthetic',url:'https://checkout.example.test/session',status:'complete'}])('B07 unverified create result %p keeps the original durable attempt unresolved',async result=>{
 Attempt.findOne.mockReturnValue(query(intent()));stripe.checkout.sessions.create.mockResolvedValue(result);
 await expect(open()).rejects.toMatchObject({code:'CHECKOUT_RESULT_UNVERIFIED'});
 expect(Attempt.updateOne).not.toHaveBeenCalled();expect(Attempt.findOneAndUpdate).not.toHaveBeenCalled();
 expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(params,{idempotencyKey:'synthetic-stable-key'});
});
test('B07 losing the local creation fence after Stripe responds cannot report a usable link',async()=>{
 Attempt.findOne.mockReturnValue(query(intent()));Attempt.updateOne.mockResolvedValue({matchedCount:0});
 await expect(open()).rejects.toMatchObject({code:'CHECKOUT_ATTEMPT_CHANGED'});expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
 expect(Attempt.findOneAndUpdate).not.toHaveBeenCalled();
});
test('B07 losing the generation claim prevents any remote create',async()=>{
 Attempt.findOneAndUpdate.mockReturnValue(query(null));
 await expect(open()).rejects.toMatchObject({code:'CHECKOUT_ATTEMPT_CHANGED'});expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test('B07 a lost lease before dispatch cannot charge a provider',async()=>{
 Attempt.findOne.mockReturnValue(query(intent()));assertDistributedLeaseActive.mockImplementation(()=>{throw Object.assign(new Error('lease lost'),{code:'LEASE_LOST'});});
 await expect(open()).rejects.toMatchObject({code:'LEASE_LOST'});expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test('B07 an interrupted create cannot switch activation purpose',async()=>{
 Attempt.findOne.mockReturnValue(query(intent({purpose:'trial'})));
 await expect(open()).rejects.toMatchObject({code:'CHECKOUT_RECONCILIATION_REQUIRED'});expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test('B07 unknown existing receipt never expires or replaces a payment link',async()=>{
 Attempt.findOne.mockReturnValue(query(intent({sessionId:'cs_saved',state:'open'})));stripe.checkout.sessions.retrieve.mockResolvedValue({id:'cs_saved',status:'unknown'});
 await expect(open()).rejects.toMatchObject({code:'CHECKOUT_RECONCILIATION_REQUIRED'});expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test('B07 replacement requires verified expiry of the superseded link',async()=>{
 Attempt.findOne.mockReturnValue(query(intent({sessionId:'cs_saved',state:'open',purpose:'trial'})));stripe.checkout.sessions.retrieve.mockResolvedValue({id:'cs_saved',status:'open'});stripe.checkout.sessions.expire.mockResolvedValue({status:'open'});
 await expect(open()).rejects.toMatchObject({code:'CHECKOUT_EXPIRATION_UNVERIFIED'});expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test('B07 a competing terminal transition cannot authorize a new generation',async()=>{
 Attempt.findOne.mockReturnValue(query(intent({sessionId:'cs_saved',state:'open'})));stripe.checkout.sessions.retrieve.mockResolvedValue({id:'cs_saved',status:'complete'});Attempt.updateOne.mockResolvedValue({matchedCount:0});
 await expect(open()).rejects.toMatchObject({code:'CHECKOUT_ATTEMPT_CHANGED'});expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});
test('B07 bounded history retains the latest retired generation on a new attempt',async()=>{
 Attempt.findOne.mockReturnValue(query(intent({state:'expired',history:Array.from({length:25},(_,generation)=>({generation,state:'expired'}))})));
 await expect(open()).resolves.toMatchObject({status:'open'});const fields=Attempt.findOneAndUpdate.mock.calls[0][1].$set;
 expect(fields.history).toHaveLength(20);expect(fields.history.at(-1)).toMatchObject({generation:2,state:'expired'});expect(fields.generation).toBe(3);
});
test.each([undefined,'cs_legacy'])('B07 absent or already migrated legacy links are inert: %p',async sessionId=>{
 Attempt.exists.mockResolvedValue(true);await retireLegacyCheckout({stripe,businessId:'tenant',sessionId});expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
});
