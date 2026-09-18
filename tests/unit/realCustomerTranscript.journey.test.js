/*
 * Replays the Sep 17, 2026 acceptance transcript through the real SMS reply
 * pipeline (no model calls, mocked calendar and persistence).
 */
import { generateAIReplyResult } from '../../src/services/aiReplyService.js';
import Catalog from '../../src/models/serviceOffering.js';
import Operations from '../../src/models/businessOperationsSettings.js';
import Alert from '../../src/services/alert.service.js';
import availability from '../../src/helpers/ai/tools/getAvailability.tool.js';
import search from '../../src/helpers/ai/tools/searchServices.tool.js';
import { approvedOffering, catalogQuery } from '../helpers/approvedServiceCatalog.js';
jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule: true, default: { find: jest.fn() } }));
jest.mock('../../src/models/businessOperationsSettings.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/services/alert.service.js', () => ({ __esModule: true, default: { create: jest.fn(), createSystemAlert: jest.fn(), createHumanHandoffAlert: jest.fn() } }));
jest.mock('../../src/helpers/ai/tools/getAvailability.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/searchServices.tool.js', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../src/helpers/ai/tools/validateServiceArea.tool.js', () => ({ __esModule: true, default: jest.fn().mockResolvedValue({ supported: true }) }));
jest.mock('../../src/helpers/ai/followUpAgent.js', () => ({ runFollowUpAgent: jest.fn() }));
jest.mock('../../src/helpers/ai/qualifyLeadWithAI.js', () => ({ qualifyLeadWithAI: jest.fn().mockRejectedValue(new Error('Unexpected model use')) }));

const context = () => {
  const c = {
    business: { _id: 'b1', businessName: 'Atlanta Pro Plumbing & Drain', businessType: 'plumbing', timezone: 'America/New_York', features: { aiBookingEnabled: false } },
    lead: { _id: 'l1', serviceNeeded: 'Unknown', urgency: 'medium', save: jest.fn().mockResolvedValue(null) },
    conversation: { _id: 'c1', status: 'open', bookingState: { status: 'not_started' }, conversationMemory: {}, lifecycle: {}, orchestration: { recoveryJourneyKey: 'j1' }, save: jest.fn().mockResolvedValue(null),
      set(path, value) { let target = this; const keys = path.split('.'); for (const key of keys.slice(0, -1)) target = target[key] ??= {}; target[keys.at(-1)] = value; } },
  };
  c.turn = customerMessage => generateAIReplyResult({ ...c, customerMessage });
  return c;
};
// Morning-only calendar, like the pilot business: 8:00 and 8:30 AM ET slots.
const morningSlots = () => [1, 2, 5].flatMap(days => {
  const day = new Date(Date.now() + days * 86400000);
  return [[12, 0], [12, 30]].map(([h, m]) => { const s = new Date(day); s.setUTCHours(h, m, 0, 0); return { startAt: s, endAt: new Date(+s + 3600000) }; });
});

beforeEach(() => {
  jest.clearAllMocks();
  Catalog.find.mockReturnValue(catalogQuery([approvedOffering('s1', 'plumbing')]));
  Operations.findOne.mockReturnValue(catalogQuery({ serviceEligibilityPolicy: { catalogComplete: true } }));
  search.mockResolvedValue([{ id: 's1', name: 'Plumbing repair', score: 1 }]);
  availability.mockResolvedValue({ supportedServiceArea: true, slots: morningSlots() });
  Alert.create.mockResolvedValue({ alert: { _id: 'a1' } });
  Alert.createSystemAlert.mockResolvedValue({ alert: { _id: 'a1' } });
});

test('a clogged sink with "no leaking or flooding" is intake, not an emergency, and nothing is re-asked', async () => {
  const c = context();
  const first = await c.turn("My kitchen sink is clogged there is no leaking or flooding. I'm Jordan Bell and my address is 56566 Road Way Atlanta Ga 30323. Can someone come next Tuesday between 2p and 4p");
  expect(first.messageCategory).not.toBe('emergency');
  expect(first.reply).not.toMatch(/911|standing water/i);
  expect(c.lead.address).toBe('56566 Road Way Atlanta Ga 30323');
  expect(c.lead.serviceNeeded).toMatch(/kitchen sink is clogged/i);
  expect(first.reply).not.toMatch(/service address/i);
  // The customer asked "can someone come", so openings (or an honest "none at
  // that time") are a valid answer; an emergency notice or re-ask is not.
  expect(first.reply).toMatch(/openings|not overflowing/i);

  const second = await c.turn("Actually it's the bathroom sink and not the kitchen sink. Wednesday after 3p would be better");
  expect(c.lead.serviceNeeded).toMatch(/bathroom sink/i);
  expect(c.lead.serviceNeeded).not.toMatch(/kitchen/i);
  expect(c.lead.preferredAppointmentTime).toMatch(/wednesday after 3p|^\d{4}-\d{2}-\d{2}/i);
  expect(second.reply).not.toMatch(/service address/i);
});

test('a real emergency still wins the turn and the address is kept for staff', async () => {
  const c = context();
  const result = await c.turn('Water is pouring through the ceiling! 12 Oak Ln Atlanta GA 30301');
  expect(result.messageCategory).toBe('emergency');
  expect(result.address).toBe('12 Oak Ln Atlanta GA 30301');
});

test('"around 5ish" with a morning-only calendar is answered honestly', async () => {
  const c = context();
  c.lead.serviceNeeded = 'toilet is clogged'; c.lead.address = '56566 Road Way Atlanta Ga 30323';
  const result = await c.turn('Do you have anything available around 5ish');
  expect(result.reply).not.toMatch(/business scheduling rules/i);
  expect(result.reply).toMatch(/don.t see an opening at that time/i);
  expect(result.reply).toMatch(/Closest openings: 1\)/);
  expect(result.reply).toMatch(/business approval required/i);
});

test('the clog question does not re-ask what the customer already answered', async () => {
  const c = context();
  const result = await c.turn('My sink is clogged but there is no flooding');
  expect(result.reply).toMatch(/noted it is not overflowing/i);
  expect(result.reply).toMatch(/other sinks, tubs, or toilets/i);
  expect(result.reply).not.toMatch(/Is water overflowing/i);
  const plain = await context().turn('My toilet is clogged');
  expect(plain.reply).toMatch(/Is water overflowing or backing up into other fixtures\?/);
});

test('expanded availability keeps an afternoon preference instead of reverting to morning slots', async () => {
 const c = context(); c.lead.serviceNeeded = 'sink repair'; c.lead.address = '56566 Road Way Atlanta GA 30323';
 const morning = morningSlots()[0];
 const evening = { ...morning, startAt: new Date(new Date(morning.startAt).setUTCHours(21, 0, 0, 0)), endAt: new Date(new Date(morning.startAt).setUTCHours(22, 0, 0, 0)) };
 availability.mockResolvedValueOnce({ supportedServiceArea: true, slots: [morning] })
   .mockResolvedValueOnce({ supportedServiceArea: true, slots: [morning, evening] });
 const result = await c.turn('Do you have anything around 5ish?');
 expect(availability).toHaveBeenCalledWith(expect.objectContaining({ postalCode: '30323' }));
 expect(result.reply).toMatch(/5:00 PM/);
 expect(result.reply).not.toMatch(/8:00 AM/);
 expect(result.reply).toMatch(/business approval required/);
});

test('invalid expanded provider data is reported as unknown availability, not no openings', async () => {
 const c = context(); c.lead.serviceNeeded = 'sink repair'; c.lead.address = '123 Main St Atlanta GA 30323';
 availability.mockResolvedValueOnce({ supportedServiceArea: true, slots: morningSlots() })
   .mockResolvedValueOnce({ supportedServiceArea: true });
 const result = await c.turn('Do you have anything around 5ish?');
 expect(result.reply).toMatch(/can.t verify live availability/i);
 expect(result.reply).not.toMatch(/don.t see an opening|business scheduling rules/i);
});
