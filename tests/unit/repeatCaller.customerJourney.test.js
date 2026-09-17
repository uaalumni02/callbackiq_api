import { optOutSms } from "../../src/services/messaging/contactPreference.service.js";
jest.mock("../../src/services/messaging/contactPreference.service.js", () => ({ optOutSms: jest.fn(async () => ({})) }));
import { handleRecoveryIntake } from '../../src/services/booking/recoveryIntake.service.js';
import { runVoiceConversationTurn } from '../../src/services/voiceConversationTurn.service.js';
import { getOrCreateSmsLeadAndConversation } from '../../src/services/messaging/smsConversation.service.js';
import Conversation from '../../src/models/conversation.js';
import Lead from '../../src/models/lead.js';
import VoiceSession from '../../src/models/voiceSession.js';
import EligibilityCatalog from '../../src/models/serviceOffering.js';
import EligibilityOperations from '../../src/models/businessOperationsSettings.js';
import { approvedOffering, catalogQuery } from '../helpers/approvedServiceCatalog.js';
import getAvailability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import searchServices from '../../src/helpers/ai/tools/searchServices.tool.js';
import validateServiceArea from '../../src/helpers/ai/tools/validateServiceArea.tool.js';
import { getApprovedServiceEstimate } from '../../src/services/booking/approvedServiceEstimate.service.js';

jest.mock('../../src/models/conversation.js', () => ({ __esModule: true, default: { findOne: jest.fn(), findOneAndUpdate: jest.fn(), findByIdAndUpdate: jest.fn() } }));
jest.mock('../../src/models/lead.js', () => ({ __esModule: true, default: { findOne: jest.fn(), findByIdAndUpdate: jest.fn() } }));
jest.mock('../../src/models/voiceSession.js', () => ({ __esModule: true, default: { findOne: jest.fn(), updateOne: jest.fn() } }));
jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock('../../src/models/businessOperationsSettings.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/services/distributedLease.service.js', () => ({
  withDistributedLease: jest.fn(async (_key, work) => ({ acquired: true, value: await work() })),
  registerDistributedLeaseGuard: jest.fn(), assertDistributedLeaseActive: jest.fn(),
}));
jest.mock('../../src/services/socket.service.js', () => ({ __esModule: true, default: { emitLeadUpdated: jest.fn(), emitConversationUpdated: jest.fn() } }));
jest.mock('../../src/services/booking/approvedServiceEstimate.service.js', () => ({ getApprovedServiceEstimate: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/searchServices.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { createHumanHandoffAlert: jest.fn() } }));

const now = new Date('2026-09-07T14:00:00Z');
let lead, conversation, business, sessions;
const query = value => Object.assign(Promise.resolve(value), { sort: async () => value });
const assign = (object, fields) => {
  for (const [key, value] of Object.entries(fields)) {
    const parts = key.split('.'); let target = object;
    for (const part of parts.slice(0, -1)) target = target[part] ||= {};
    target[parts.at(-1)] = value;
  }
  return object;
};
beforeEach(() => {
  jest.clearAllMocks();
  lead = { _id: 'l1', phone: '+14045550100', phoneLookup: '+14045550100', serviceNeeded: 'Unknown', urgency: 'medium', status: 'contacted', save: jest.fn() };
  conversation = { _id: 'c1', business: 'b1', lead: 'l1', status: 'open', aiEnabled: true, humanTakeover: false,
    customerPhone: lead.phone, customerPhoneLookup: lead.phone, bookingState: { status: 'not_started' },
    orchestration: { recoveryJourneyKey: 'original', recoveryIntroClaimedAt: new Date(0) }, conversationMemory: {},
    save: jest.fn(), set(path, value) { assign(this, { [path]: value }); } };
  business = { _id: 'b1', businessName: 'HVAC Business', businessType: 'HVAC', timezone: 'America/New_York', features: { aiBookingEnabled: false } };
  sessions = ['v1', 'v2', 'v3'].map(_id => ({ _id, business, conversation, lead, status: 'active', metadata: {}, save: jest.fn() }));
  Conversation.findOne.mockImplementation(() => query(conversation));
  Conversation.findByIdAndUpdate.mockImplementation(async (_, update) => assign(conversation, update));
  Conversation.findOneAndUpdate.mockImplementation(async (_, update) => assign(conversation, update.$set));
  Lead.findOne.mockImplementation(() => query(lead));
  Lead.findByIdAndUpdate.mockImplementation(async (_, update) => assign(lead, update));
  VoiceSession.findOne.mockImplementation(async ({ _id }) => sessions.find(s => s._id === _id && s.status !== 'completed'));
  VoiceSession.updateOne.mockImplementation(async ({ _id }, update) => assign(sessions.find(s => s._id === _id), update.$set));
  EligibilityCatalog.find.mockReturnValue(catalogQuery([approvedOffering('s1', 'hvac', [])]));
  EligibilityOperations.findOne.mockReturnValue(catalogQuery({ serviceEligibilityPolicy: { catalogComplete: true } }));
  validateServiceArea.mockResolvedValue({ supported: true });
  searchServices.mockResolvedValue([{ id: 's1', score: 1 }]);
  getApprovedServiceEstimate.mockResolvedValue('');
  getAvailability.mockResolvedValue({ slots: [{ startAt: '2026-09-09T08:00:00-04:00', endAt: '2026-09-09T09:00:00-04:00' }] });
});
const turn = (session, customerMessage) => runVoiceConversationTurn({ session, customerMessage,
  operation: () => handleRecoveryIntake({ business, lead: session.lead, conversation: session.conversation, channel: 'voice', session, now, customerMessage,
    semanticAssessment: { isInScope: true, confidence: 95, serviceNeeded: lead.serviceNeeded === 'Unknown' ? 'AC repair' : lead.serviceNeeded } }),
});

test('full intake survives repeat calls beyond cooldown and conflicting interleaved voice turns', async () => {
  const [owner, other] = sessions;
  const first = await turn(owner, 'My AC is blowing warm air');
  expect(first.reply).not.toMatch(/what service/i);
  await turn(owner, '87 Oak Lane Marietta GA 30060');
  await getOrCreateSmsLeadAndConversation({ business, customerPhone: lead.phone, source: 'missed_call', recoveryJourneyKey: 'CA-repeat' });
  const blocked = await turn(other, 'My furnace is broken at 999 Other Street');
  expect(blocked.reply).toMatch(/Another call/);
  await turn(owner, 'Wednesday September 9');
  const complete = await turn(owner, '8 am');
  expect(complete.intakeReady).toBe(true);
  expect(complete.intakeCompletionReply).toMatch(/not confirmed/);
  expect(lead.address).toBe('87 Oak Lane Marietta GA 30060');
  expect(lead.serviceNeeded).not.toMatch(/furnace|999/);
  expect(conversation.orchestration.recoveryJourneyKey).toBe('original');
  owner.status = 'completed';
  const afterClose = await turn(other, 'Change it to 4 pm');
  expect(afterClose.reply).toMatch(/Another call/);
  expect(lead.preferredAppointmentTime).toMatch(/8:00/);
});

test('SMS-collected facts are refreshed into voice and an overlapping emergency still receives guidance', async () => {
  const [owner, other] = sessions;
  await handleRecoveryIntake({ business, lead, conversation, channel: 'sms', now,
    customerMessage: 'AC not cooling, 87 Oak Lane Marietta GA 30060, Wed Sep 9 at 8 am',
    semanticAssessment: { isInScope: true, confidence: 95, serviceNeeded: 'AC repair' } });
  await turn(owner, 'What happens next?');
  const operation = jest.fn();
  const result = await runVoiceConversationTurn({ session: other, customerMessage: 'I smell gas', operation });
  expect(result.reply).toMatch(/leave|911/i);
  expect(operation).not.toHaveBeenCalled();
  expect(lead.address).toBe('87 Oak Lane Marietta GA 30060');
  expect(lead.preferredAppointmentTime).toMatch(/8:00/);
});

test('a read-only overlapping caller can still withdraw contact consent and end their call', async () => {
  const [owner, other] = sessions;
  await turn(owner, 'My AC is blowing warm air');
  await turn(other, 'My furnace is broken');
  const result = await turn(other, 'Stop texting me');
  expect(result.outcome).toBe('opted_out');
  expect(result.handoff.type).toBe('end');
  expect(optOutSms).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'b1', phone: lead.phone }));
  expect(conversation.aiEnabled).toBe(false);
});
