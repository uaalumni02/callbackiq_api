import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../src/app.js';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import BillingEvent from '../../src/models/billingEvent.js';
import Delivery from '../../src/models/trialLifecycleDelivery.js';
import Grant from '../../src/models/trialExtensionGrant.js';
import { getStripeClient, resetStripeClient } from '../../src/helpers/stripe/stripeClient.js';
import { reserveStripeEvent, markStripeEventProcessed, markStripeEventFailed, processStripeEventOnce } from '../../src/services/billingEvent.service.js';
import { sendTrialNotice, reconcileTrialNotices } from '../../src/services/trialLifecycleDelivery.service.js';
import { extendTrial, reconcileTrialExtensions } from '../../src/services/trialExtension.service.js';
import { sendTrialReminderEmail } from '../../src/helpers/email/mailer.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';
jest.mock('../../src/helpers/email/mailer.js', () => ({ sendTrialReminderEmail: jest.fn(),
 sendTrialWelcomeEmail: jest.fn(), sendTrialExpiredEmail: jest.fn(), sendTrackingNumberReleasedEmail: jest.fn(), sendPasswordResetEmail: jest.fn() }));
beforeAll(async () => { await connectTestDB(); await BillingEvent.createIndexes(); await Grant.createIndexes(); }, 60000);
afterEach(async () => { jest.restoreAllMocks(); await clearTestDB(); });
afterAll(closeTestDB);
beforeEach(() => {
 process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
 process.env.STRIPE_WEBHOOK_SECRET = 'whsec_remediation_synthetic'; resetStripeClient();
 sendTrialReminderEmail.mockReset().mockResolvedValue({ messageId: 'synthetic-email-receipt' });
});
async function fixture(status = 'active') {
 const owner = new mongoose.Types.ObjectId();
 const business = await Business.create({ owner, businessName: 'Synthetic Plumbing', businessType: 'plumbing',
 email: 'synthetic@example.com', phone: '+14045550121', isActive: true });
 const subscription = await Subscription.create({ business: business._id, stripeCustomerId: 'cus_synthetic',
 stripeSubscriptionId: 'sub_synthetic', plan: 'pro', status, isActive: true, aiEnabled: true,
 trialUsedAt: new Date(), trialEndsAt: new Date(Date.now() + 2 * 86400000) });
 return { owner, business, subscription };
}
function postEvent(event, invalid = false) {
 const payload = JSON.stringify(event);
 const signature = getStripeClient().webhooks.generateTestHeaderString({ payload,
 secret: invalid ? 'whsec_incorrect_synthetic' : process.env.STRIPE_WEBHOOK_SECRET });
 return request(app).post('/api/billing/webhook').set('stripe-signature', signature).set('content-type','application/json').send(payload);
}
test('signed late failure cannot replace the current paid invoice; unfinished duplicate requests retry', async () => {
 const { business, owner } = await fixture(); const now = Math.floor(Date.now() / 1000);
 const remote = { id: 'sub_synthetic', customer: 'cus_synthetic', status: 'active',
 metadata: { businessId: business.id, ownerId: String(owner), plan: 'pro' },
 items: { data: [{ current_period_start: now-60, current_period_end: now+3600, price: { id:'price_synthetic' } }] },
 latest_invoice: { id:'in_current_paid',status:'paid' } };
 jest.spyOn(getStripeClient().subscriptions,'retrieve').mockResolvedValue(remote);
 jest.spyOn(getStripeClient().subscriptions,'list').mockResolvedValue({data:[remote],has_more:false});
 const event = (id,type,invoice,created) => ({id,type,created,data:{object:{id:invoice,customer:remote.customer,subscription:remote.id,currency:'usd',billing_reason:'subscription_cycle'}}});
 expect((await postEvent(event('evt_paid','invoice.paid','in_current_paid',now))).status).toBe(200);
 expect((await postEvent(event('evt_old_failed','invoice.payment_failed','in_old',now-60))).status).toBe(200);
 const stored = await Subscription.findOne({business:business._id});
 expect(stored).toMatchObject({latestInvoiceId:'in_current_paid',lastPaymentStatus:'paid',status:'active'});
 expect(stored.currentPeriodEnd.getTime()).toBe((now+3600)*1000);
 const live=event('evt_live','invoice.paid','in_current_paid',now);await reserveStripeEvent(live);
 const duplicate=await postEvent(live);expect(duplicate.status).toBe(503);expect(duplicate.headers['retry-after']).toBeTruthy();
 expect((await BillingEvent.findOne({providerEventId:live.id})).status).toBe('processing');
 expect((await postEvent(event('evt_invalid','invoice.paid','in_current_paid',now),true)).status).toBe(400);
});
test('stale Stripe claimant cannot complete or fail a reclaimed event', async () => {
 const event={id:'evt_stale',type:'invoice.paid',data:{object:{id:'invoice'}}};const first=await reserveStripeEvent(event);
 await BillingEvent.updateOne({_id:first.record._id},{$set:{processingStartedAt:new Date(0)}});
 const second=await reserveStripeEvent(event);expect(second.record.processingToken).not.toBe(first.record.processingToken);
 expect(await markStripeEventProcessed(event.id,{processingToken:first.record.processingToken})).toBeNull();
 expect(await markStripeEventFailed(event.id,new Error('stale'),first.record.processingToken)).toBeNull();
 expect((await BillingEvent.findById(first.record._id)).status).toBe('processing');
 expect((await markStripeEventProcessed(event.id,{processingToken:second.record.processingToken})).status).toBe('processed');
});
test('concurrent reminder snapshots claim before sending and produce one durable receipt', async () => {
 const {subscription}=await fixture('trialing');const copies=await Promise.all(Array.from({length:8},()=>Subscription.findById(subscription._id)));
 expect((await Promise.all(copies.map(copy=>sendTrialNotice(copy,'three_day')))).filter(Boolean)).toHaveLength(1);
 expect(sendTrialReminderEmail).toHaveBeenCalledTimes(1);expect(await Delivery.countDocuments({status:'sent'})).toBe(1);
 expect((await Subscription.findById(subscription._id)).trialReminder3dSentAt).toBeTruthy();
});
test('unknown email acceptance is held for review and cannot resend automatically', async () => {
 const {subscription}=await fixture('trialing');sendTrialReminderEmail.mockRejectedValueOnce(new Error('provider timed out after request'));
 await expect(sendTrialNotice(subscription,'one_day')).rejects.toThrow('provider timed out');
 expect(await sendTrialNotice(subscription,'one_day')).toBe(false);expect(sendTrialReminderEmail).toHaveBeenCalledTimes(1);
 expect((await Delivery.findOne()).status).toBe('uncertain');await reconcileTrialNotices();expect((await Delivery.findOne()).reviewRecorded).toBe(true);
});
test('extension reconciles a lost acknowledgement; replay never adds days twice', async () => {
 const {business,owner,subscription}=await fixture('trialing');const targets=[];
 jest.spyOn(getStripeClient().subscriptions,'update').mockImplementation(async(_id,body,options)=>{targets.push({body,options});
 if(targets.length===1)throw new Error('connection lost after provider accepted');return{status:'trialing',trial_end:body.trial_end};});
 const input={businessId:business.id,adminUserId:String(owner),days:7,reason:'Synthetic support incident',operationKey:'stable-operation'};
 await expect(extendTrial(input)).rejects.toMatchObject({providerOutcome:'uncertain',code:'BILLING_PROVIDER_FAILED',
  cause:expect.objectContaining({message:'connection lost after provider accepted'})});
 expect((await Subscription.findById(subscription._id)).trialExtensionIntent.status).toBe('pending');
 expect((await reconcileTrialExtensions()).errors).toEqual([]);await extendTrial(input);
 const stored=await Subscription.findById(subscription._id);
 expect(stored.trialEndsAt.getTime()).toBe(Math.floor((subscription.trialEndsAt.getTime()+7*86400000)/1000)*1000);
 expect(stored.trialExtensionDaysReserved).toBe(7);expect(await Grant.countDocuments({business:business._id})).toBe(1);
 expect(targets).toHaveLength(2);expect(targets[0]).toEqual(targets[1]);
});

test('lost ledger ownership cannot acknowledge an event or fail its replacement owner', async () => {
 const event={id:'evt_replaced',type:'invoice.paid',data:{object:{id:'invoice_replaced',customer:'cus_replaced'}}};
 await expect(processStripeEventOnce({event,handlers:{'invoice.paid':async()=>{
  await BillingEvent.updateOne({providerEventId:event.id},{$set:{processingToken:'replacement-owner'}});
 }}})).rejects.toMatchObject({code:'BILLING_EVENT_CLAIM_LOST'});
 expect(await BillingEvent.findOne({providerEventId:event.id})).toMatchObject({status:'processing',processingToken:'replacement-owner'});
});
