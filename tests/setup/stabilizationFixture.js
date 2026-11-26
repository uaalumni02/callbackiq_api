import mongoose from 'mongoose';
import User from '../../src/models/user.js';
import Business from '../../src/models/business.js';
import Subscription from '../../src/models/subscription.js';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import Token from '../../src/helpers/jwt/token.js';
let fixturePhone = 2000;
const nextFixturePhone = () => `+1404555${String(++fixturePhone).padStart(4, '0')}`;
export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export async function stabilizationFixture() {
  const id = new mongoose.Types.ObjectId();
  const user = await User.create({ userName: `Owner${id}`, email: `${id}@example.test`, password: 'unused-synthetic-hash', role: 'owner', businessName: 'Synthetic stabilization', termsAccepted: true, privacyAccepted: true });
  const business = await Business.create({ owner: user._id, businessName: 'Synthetic stabilization', forwardingPhone: nextFixturePhone(), isActive: true });
  await Subscription.create({ business: business._id, status: 'active', isActive: true, plan: 'pro' });
  const lead = await Lead.create({ business: business._id, phone: '+14045550100', serviceNeeded: 'Sink repair', address: 'Original address', status: 'new' });
  const conversation = await Conversation.create({ business: business._id, lead: lead._id, customerPhone: lead.phone });
  const token = Token.sign({ userId: String(user._id), role: 'owner', sessionVersion: 0 });
  return { user, business, lead, conversation, token };
}

export async function activateCustomerAccess(businessId) {
  return Subscription.findOneAndUpdate({ business: businessId }, { $set: { status: 'active', isActive: true } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
}
export async function customerAccessForUser(user) {
  const business = await Business.create({ owner: user._id, businessName: user.businessName || 'Synthetic test business',
    isActive: true, forwardingPhone: nextFixturePhone() });
  await activateCustomerAccess(business._id);
  return business;
}
