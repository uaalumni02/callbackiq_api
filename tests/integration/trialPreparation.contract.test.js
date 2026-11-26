import request from 'supertest';
import app from '../../src/app.js';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import TrialRedemption from '../../src/models/trialRedemption.js';
import A2pCustomerRegistration from '../../src/models/a2pCustomerRegistration.js';
import { createTwilioClient } from '../../src/integrations/providerClients.js';
import { getStripeClient } from '../../src/helpers/stripe/stripeClient.js';
import { buildTwilioWebhookUrls } from '../../src/services/twilioWebhookReliability.service.js';
import { createSubscriptionCheckout, syncCheckoutSession, processTrialLifecycle } from '../../src/services/trialLifecycle.service.js';
import { reconcileTrialPreparations } from '../../src/services/trialPreparation.service.js';
import { markNumberRegistrationEvent } from '../../src/services/a2pCustomerOnboarding.service.js';
import { getSubscriptionAccess } from '../../src/services/subscriptionAccess.service.js';
import { provisionTrackingNumber } from '../../src/services/trackingNumberProvisioning.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testReplicaDb.js';

jest.mock('../../src/integrations/providerClients.js', () => ({ ...jest.requireActual('../../src/integrations/providerClients.js'), createTwilioClient: jest.fn() }));
jest.mock('../../src/helpers/stripe/stripeClient.js', () => ({ getStripeClient: jest.fn(), getPriceIdByPlan: () => 'price_pro' }));
jest.mock('../../src/services/a2pCustomerOnboarding.service.js', () => ({ ...jest.requireActual('../../src/services/a2pCustomerOnboarding.service.js'), syncA2pCustomerRegistration: jest.fn(async () => ({ status: 'number_pending' })) }));
jest.mock('../../src/helpers/email/mailer.js', () => ({ sendEmailVerificationEmail: jest.fn(), sendTrialWelcomeEmail: jest.fn(async () => ({ messageId: 'welcome' })), sendTrialReminderEmail: jest.fn(), sendTrialExpiredEmail: jest.fn(), sendTrackingNumberReleasedEmail: jest.fn() }));

let stripe, inventory, purchase, remove;
beforeAll(connectTestDB, 60000);
afterEach(clearTestDB);
afterAll(closeTestDB);
beforeEach(() => {
  jest.clearAllMocks();
  process.env.TWILIO_ACCOUNT_SID = 'AC11111111111111111111111111111111';
  process.env.TWILIO_AUTH_TOKEN = 'test-trial-setup-token';
  const urls = buildTwilioWebhookUrls('https://api.example.test');
  inventory = jest.fn(async () => [{ phoneNumber: '+14045550123' }]);
  purchase = jest.fn(async () => ({ sid: 'PN_PREPARED', phoneNumber: '+14045550123' }));
  remove = jest.fn(async () => true);
  const incomingPhoneNumbers = Object.assign(() => ({ fetch: async () => ({ phoneNumber: '+14045550123', ...urls }), update: async () => ({}), remove }), { create: purchase });
  createTwilioClient.mockReturnValue({ availablePhoneNumbers: () => ({ local: { list: inventory } }), incomingPhoneNumbers });
  stripe = { customers: { create: jest.fn(async () => ({ id: 'cus_prepared' })) },
    subscriptions: { list: jest.fn(async () => ({ data: [] })), retrieve: jest.fn() },
    checkout: { sessions: { create: jest.fn(async () => ({ id: 'cs_prepared', status:'open', url: 'https://checkout.stripe.test/prepared' })), retrieve: jest.fn(), expire: jest.fn(async () => ({ id: 'cs_prepared', status: 'expired' })) } } };
  getStripeClient.mockReturnValue(stripe);
});

async function fixture() {
  const response = await request(app).post('/api/auth/register').send({ userName: 'preparedowner', email: 'prepared@example.com', password: 'TestPassword123', businessName: 'Prepared Business', businessType: 'other', forwardingPhone: '+14045551212', termsAccepted: true, privacyAccepted: true });
  expect(response.status).toBe(201);
  const business = await Business.findById(response.body.data.business._id);
  await A2pCustomerRegistration.create({ business: business._id, status: 'number_pending', messagingServiceSid: 'MG_PREPARED', campaignSid: 'QE_PREPARED' });
  return { business, ownerId: response.body.data.user._id, token: response.body.data.token };
}
async function approve(business) {
  await markNumberRegistrationEvent({ phoneNumberSid: 'PN_PREPARED', messagingServiceSid: 'MG_PREPARED', campaignSid: 'QE_PREPARED', externalStatus: 'REGISTERED', eventType: 'com.twilio.messaging.compliance.registration.successful', eventId: 'registered-prepared', eventAt: new Date() });
  expect((await Business.findById(business._id)).messagingCompliance.smsReady).toBe(true);
}
const activate = owner => createSubscriptionCheckout({ ...owner, requireTrial: true, returnToSetup: true });

test('prepares a real number without a Stripe trial, entitlement, or consumed lifetime trial', async () => {
  const owner = await fixture();
  const result = await activate(owner);
  expect(result.preparing).toBe(true);
  expect(purchase).toHaveBeenCalledTimes(1);
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  expect(stripe.customers.create).not.toHaveBeenCalled();
  expect(result.subscription).toMatchObject({ status: 'none', isActive: false, aiEnabled: false, trialStartedAt: null, trialEndsAt: null, trialUsedAt: null });
  expect(getSubscriptionAccess(result.subscription).level).toBe('read_only');
  expect(await TrialRedemption.countDocuments()).toBe(0);
  const denied = await request(app).get('/api/leads').set('Authorization', `Bearer ${owner.token}`);
  expect(denied.status).toBe(403);
});

test('carrier approval unlocks no-card Checkout; its completion grants all 14 days and keeps the prepared number', async () => {
  const owner = await fixture();
  await activate(owner);
  await approve(owner.business);
  const ready = await activate(owner);
  expect(ready.checkoutUrl).toContain('checkout.stripe.test');
  expect(purchase).toHaveBeenCalledTimes(1);
  expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ payment_method_collection: 'if_required', subscription_data: expect.objectContaining({ trial_period_days: 14, trial_settings: { end_behavior: { missing_payment_method: 'pause' } } }) }), expect.anything());
  const start = Math.floor(Date.now() / 1000), end = start + 14 * 86400;
  stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_prepared', customer: 'cus_prepared', status: 'trialing', trial_start: start, trial_end: end, items: { data: [{ price: { id: 'price_pro', unit_amount: 9900 } }] }, metadata: { businessId: String(owner.business._id), ownerId: String(owner.ownerId), plan: 'pro' } });
  const active = await syncCheckoutSession({ id: 'cs_prepared', subscription: 'sub_prepared', metadata: { businessId: String(owner.business._id), ownerId: String(owner.ownerId) } });
  expect(active.trialEndsAt - active.trialStartedAt).toBe(14 * 86400000);
  expect(active.isActive).toBe(true);
  expect(active.trialNumberReleaseAt).toBeNull();
  expect(await TrialRedemption.countDocuments()).toBe(1);
  expect(purchase).toHaveBeenCalledTimes(1);
});

test('inventory failures and retries never start billing or consume trial days', async () => {
  const owner = await fixture();
  inventory.mockResolvedValueOnce([]);
  expect((await activate(owner)).preparing).toBe(true);
  expect(purchase).not.toHaveBeenCalled();
  expect((await activate(owner)).preparing).toBe(true);
  expect(purchase).toHaveBeenCalledTimes(1);
  const row = await Subscription.findOne({ business: owner.business._id });
  expect(row.trialUsedAt).toBeNull();
  expect(row.trialEndsAt).toBeNull();
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});

test('approval alone does not start a trial, and background preparation survives closing the browser', async () => {
  const owner = await fixture();
  inventory.mockResolvedValueOnce([]);
  await activate(owner);
  await reconcileTrialPreparations();
  expect(purchase).toHaveBeenCalledTimes(1);
  await approve(owner.business);
  await reconcileTrialPreparations();
  expect((await Subscription.findOne({ business: owner.business._id })).trialPreparation.state).toBe('ready');
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});

test('registration failure or sender membership without approval cannot unlock Checkout', async () => {
  const owner = await fixture();
  await activate(owner);
  await Business.updateOne({ _id: owner.business._id }, { $set: { 'messagingCompliance.senderAttached': true, 'messagingCompliance.smsReady': false } });
  expect((await activate(owner)).preparing).toBe(true);
  expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
});

test('concurrent requests purchase at most one number', async () => {
  const owner = await fixture();
  const results = await Promise.allSettled([activate(owner), activate(owner)]);
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  expect(purchase).toHaveBeenCalledTimes(1);
  expect(await TrialRedemption.countDocuments()).toBe(0);
});

test('a normal inactive account has no permission to purchase a number', async () => {
  const owner = await fixture();
  await expect(provisionTrackingNumber(owner.business._id)).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });
  expect(purchase).not.toHaveBeenCalled();
});

test('an abandoned preparation releases its number without using the lifetime trial', async () => {
  const owner = await fixture();
  await activate(owner);
  const past = new Date(Date.now() - 1000);
  await Subscription.updateOne({ business: owner.business._id }, { $set: { 'trialPreparation.expiresAt': past, trialNumberReleaseAt: past } });
  await processTrialLifecycle();
  const row = await Subscription.findOne({ business: owner.business._id });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(row.trialPreparation.state).toBe('expired');
  expect(row.trialUsedAt).toBeNull();
  expect(await TrialRedemption.countDocuments()).toBe(0);
  expect((await Business.findById(owner.business._id)).phone).toBeUndefined();
});

test('a retry retires the earlier activation link if carrier readiness is lost', async () => {
  const owner = await fixture();
  await activate(owner);
  await approve(owner.business);
  await activate(owner);
  stripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_prepared', status: 'open' });
  await Business.updateOne({ _id: owner.business._id }, { $set: { 'messagingCompliance.smsReady': false } });
  expect((await activate(owner)).preparing).toBe(true);
  expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_prepared');
  expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  expect((await Subscription.findOne({ business: owner.business._id })).trialUsedAt).toBeNull();
});

test('a failed checkout reconciliation postpones cleanup and retains the number', async () => {
  const owner = await fixture();
  await activate(owner);
  await approve(owner.business);
  await activate(owner);
  const past = new Date(Date.now() - 1000);
  await Subscription.updateOne({ business: owner.business._id }, { $set: { 'trialPreparation.expiresAt': past, trialNumberReleaseAt: past } });
  stripe.checkout.sessions.retrieve.mockRejectedValue(new Error('Synthetic Stripe outage'));
  await processTrialLifecycle();
  expect(remove).not.toHaveBeenCalled();
  expect((await Business.findById(owner.business._id)).phone).toBe('+14045550123');
});

test('number-hold capacity counts pending preparations but allows their existing owner to finish', async () => {
  const owner = await fixture();
  await activate(owner);
  await approve(owner.business);
  process.env.TRIAL_MAX_TRACKING_NUMBERS_HELD = '1';
  try {
    expect((await activate(owner)).checkoutUrl).toBeTruthy();
  } finally { delete process.env.TRIAL_MAX_TRACKING_NUMBERS_HELD; }
});

test('retries preserve the preparation deadline and cannot create an indefinite free-number reservation', async () => {
  const owner = await fixture();
  const first = await activate(owner);
  const again = await activate(owner);
  expect(again.subscription.trialPreparation.expiresAt).toEqual(first.subscription.trialPreparation.expiresAt);
  await Subscription.updateOne({ business: owner.business._id }, { $set: { 'trialPreparation.expiresAt': new Date(Date.now() - 1000) } });
  await expect(activate(owner)).rejects.toMatchObject({ code: 'TRIAL_PREPARATION_EXPIRED' });
});

test('cleanup reconciles a completed activation before touching its prepared number', async () => {
  const owner = await fixture();
  await activate(owner);
  await approve(owner.business);
  await activate(owner);
  const past = new Date(Date.now() - 1000), start = Math.floor(Date.now() / 1000);
  await Subscription.updateOne({ business: owner.business._id }, { $set: { 'trialPreparation.expiresAt': past, trialNumberReleaseAt: past } });
  stripe.checkout.sessions.retrieve.mockResolvedValue({ id: 'cs_prepared', status: 'complete', subscription: 'sub_prepared', metadata: { businessId: String(owner.business._id), ownerId: String(owner.ownerId) } });
  stripe.subscriptions.retrieve.mockResolvedValue({ id: 'sub_prepared', customer: 'cus_prepared', status: 'trialing', trial_start: start, trial_end: start + 14 * 86400, metadata: { businessId: String(owner.business._id), ownerId: String(owner.ownerId), plan: 'pro' } });
  await processTrialLifecycle();
  expect(remove).not.toHaveBeenCalled();
  expect((await Subscription.findOne({ business: owner.business._id })).status).toBe('trialing');
});
