import mongoose from 'mongoose';
import Lead from '../../src/models/lead.js';
import Conversation from '../../src/models/conversation.js';
import { reconcileConversationLead } from '../../src/services/messaging/conversationLeadIdentity.service.js';
import { getOrCreateSmsLeadAndConversation } from '../../src/services/messaging/smsConversation.service.js';
import { connectTestDB, clearTestDB, closeTestDB } from '../setup/testDb.js';
jest.mock('../../src/services/socket.service.js', () => ({ __esModule: true, default: {
  emitConversationUpdated: jest.fn(), emitConversationCreated: jest.fn(), emitLeadUpdated: jest.fn(), emitLeadCreated: jest.fn(),
} }));
beforeAll(async () => { await connectTestDB(); await Promise.all([Lead.init(), Conversation.init()]); }, 30000);
afterEach(clearTestDB);
afterAll(closeTestDB);
const phone = '+14045550101';
async function fixture() {
  const business = { _id: new mongoose.Types.ObjectId() };
  const old = await Lead.create({ business: business._id, phone, serviceNeeded: 'clogged sink' });
  const conversation = await Conversation.create({ business: business._id, lead: old._id, customerPhone: phone,
    humanTakeover: true, aiEnabled: false, conversationMemory: { recoveryIntake: { submitted: true } } });
  await Lead.deleteOne({ _id: old._id });
  return { business, conversation, old };
}
test('real ingress repairs dangling reference without releasing staff ownership', async () => {
  const { business } = await fixture();
  const result = await getOrCreateSmsLeadAndConversation({ business, customerPhone: phone, body: 'My sink is clogged' });
  const saved = await Conversation.findById(result.conversation._id);
  expect(String(saved.lead)).toBe(String(result.lead._id));
  expect(saved.humanTakeover).toBe(true); expect(saved.aiEnabled).toBe(false);
  expect(saved.conversationMemory.recoveryIntake).toEqual({});
});
test('racing repairs cannot overwrite one another', async () => {
  const { business, conversation } = await fixture();
  const lead = await Lead.create({ business: business._id, phone, serviceNeeded: 'clogged sink' });
  const results = await Promise.allSettled([1, 2].map(() => reconcileConversationLead({ business, conversation, lead, customerPhone: phone })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected').reason.code).toBe('SMS_LEAD_REPAIR_CONFLICT');
  expect(String((await Conversation.findById(conversation._id)).lead)).toBe(String(lead._id));
});
test('never repairs to a different tenant even if the phone matches', async () => {
  const { business, conversation } = await fixture();
  const lead = await Lead.create({ business: new mongoose.Types.ObjectId(), phone, serviceNeeded: 'clogged sink' });
  await expect(reconcileConversationLead({ business, conversation, lead, customerPhone: phone })).rejects.toMatchObject({ code: 'SMS_LEAD_IDENTITY_CONFLICT' });
});
