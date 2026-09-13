jest.mock('../../src/models/serviceOffering.js', () => ({ __esModule: true, default: { find: jest.fn() } }));
import EligibilityCatalog from '../../src/models/serviceOffering.js';
import EligibilityOperations from '../../src/models/businessOperationsSettings.js';
import { approvedOffering, catalogQuery } from '../helpers/approvedServiceCatalog.js';
jest.mock('../../src/models/businessOperationsSettings.js', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
beforeEach(() => {
  EligibilityCatalog.find = jest.fn(() => catalogQuery([approvedOffering('service-1', 'plumbing', ['dish washer', 'dishwasher'])]));
  EligibilityOperations.findOne.mockReturnValue(catalogQuery({ serviceEligibilityPolicy: { catalogComplete: true } }));
});
import { schedulingQuestionReply } from "../../src/services/booking/schedulingQuestions.service.js";
import OpenAI from "openai";
import { generateAIReplyResult } from "../../src/services/aiReplyService.js";
import { resetFollowUpOpenAIClient } from "../../src/helpers/ai/followUpAgent.js";
import searchServices from "../../src/helpers/ai/tools/searchServices.tool.js";
import getAvailability from "../../src/helpers/ai/tools/getAvailability.tool.js";
import createAppointment from "../../src/helpers/ai/tools/createAppointment.tool.js";
import { classifySmsIntent } from "../../src/services/messaging/smsIntentClassifier.service.js";
import { sanitizeOutboundReply } from "../../src/helpers/ai/aiGuardrails.js";

jest.mock("openai", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/services/communicationUsage.service.js", () => ({ reserveAiUsage: jest.fn().mockResolvedValue({ allowed: true }) }));
jest.mock("../../src/services/businessConfiguration.service.js", () => ({ buildAIConfigurationContext: jest.fn().mockResolvedValue({}) }));
jest.mock("../../src/helpers/ai/qualifyLeadWithAI.js", () => ({ qualifyLeadWithAI: jest.fn().mockResolvedValue({}), resetQualificationOpenAIClient: jest.fn() }));
jest.mock("../../src/helpers/ai/tools/searchServices.tool.js", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/helpers/ai/tools/getAvailability.tool.js", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/helpers/ai/tools/createAppointment.tool.js", () => ({ __esModule: true, default: jest.fn() }));

const first = "My kitchen sink is clogged and dish washer is leaking water. When can someone come out";
const business = { _id: "business-1", businessName: "Atlanta Pro Plumbing & Drain", timezone: "America/New_York", features: { aiBookingEnabled: false } };
const modelReply = { decision: "send", actionType: "collect_appointment_preference", messageCategory: "appointment_preference", reply: "I have both the clogged sink and dishwasher leak. Is water still leaking?", serviceNeeded: "kitchen sink clog and dishwasher leak", urgency: "medium", address: "", preferredAppointmentTime: "", leadQualityScore: 50, estimatedValue: 0, summary: "Both plumbing issues captured", shouldAlertOwner: false, alertPriority: "low", riskFlags: [], confidence: 95 };
const create = jest.fn();
const originalKey = process.env.OPENAI_API_KEY;
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date("2026-09-08T00:10:00Z"));
  process.env.OPENAI_API_KEY = "test-key";
  resetFollowUpOpenAIClient();
  OpenAI.mockImplementation(() => ({ responses: { create } }));
  create.mockResolvedValue({ output_text: JSON.stringify(modelReply) });
  searchServices.mockResolvedValue([]);
});
afterEach(() => { jest.useRealTimers(); resetFollowUpOpenAIClient(); if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });

test("real SMS reply pipeline replays all five customer turns without losing service, preference, or questions", async () => {
  const lead = { serviceNeeded: "Unknown", urgency: "medium" };
  const conversation = { bookingState: { status: "not_started" } };
  const messages = [{ direction: "outbound", body: "Sorry we missed your call. What service do you need?" }];
  const turn = async body => {
    messages.push({ direction: "inbound", body });
    const result = await generateAIReplyResult({ business, lead, conversation, messages });
    // The worker persists nonempty extracted fields after generation, before delivery.
    for (const field of ["serviceNeeded", "urgency", "preferredAppointmentTime"]) if (result[field]) lead[field] = result[field];
    messages.push({ direction: "outbound", body: result.reply });
    return result;
  };
  const one = await turn(first);
  expect(one.reply).toMatch(/sink.*dish washer/i);
  expect(one.reply).toMatch(/still leaking/i);
  expect(one.reply).not.toMatch(/what service/i);
  expect(lead.serviceNeeded).toMatch(/sink.*dish washer/i);
  // An unspecified leak requires clarification; active leakage is not established.
  expect(lead.urgency).toBe("medium");
  expect(searchServices).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringMatching(/sink.*dish washer/i) }));
  const two = await turn("Kitchen sink is clogged and dishwasher leaks");
  expect(two.reply).toContain("Is water still leaking?");
  expect(two.reply).not.toMatch(/reply with the days/i);
  const three = await turn("Wed at 9 am");
  expect(three.reply).toMatch(/Wednesday, Sep 9 at 9:00 AM/);
  expect(three.reply).not.toMatch(/reviewed|under review|submitted/);
  const preference = lead.preferredAppointmentTime;
  const four = await turn("Thanks can I be added to a wait list as well");
  expect(four.reply).toMatch(/can’t enroll.*waitlist/);
  expect(lead.preferredAppointmentTime).toBe(preference);
  const five = await turn("Is there an emergency time?");
  expect(five.reply).toMatch(/emergency-service availability/);
  expect(five.reply).toMatch(/still leaking/);
  expect(five.reply).not.toBe(four.reply);
  expect(lead.preferredAppointmentTime).toBe(preference);
  expect(createAppointment).not.toHaveBeenCalled();
});

test("first compound turn reaches the live calendar when a service matches", async () => {
  searchServices.mockResolvedValue([{ id: "service-1", name: "Plumbing visit" }]);
  getAvailability.mockResolvedValue({ supportedServiceArea: true, slots: [] });
  const result = await generateAIReplyResult({ business, lead: { serviceNeeded: "Unknown" }, conversation: { bookingState: { status: "not_started" } }, messages: [{ direction: "inbound", body: first }] });
  expect(getAvailability).toHaveBeenCalled();
  expect(result.serviceNeeded).toMatch(/sink.*dish washer/i);
  expect(result.reply).not.toMatch(/what service/i);
});

test.each(["Thanks can I be added to a wait list as well", "Is there an emergency time?"])("question is not a new customer time preference: %s", text => {
  expect(classifySmsIntent({ customerMessage: text }).intents.availabilityInquiry).toBe(true);
});

test.each([
  ["I've added you to the waitlist.", "unverified_waitlist_enrollment"],
  ["You're next if someone cancels.", "unverified_waitlist_enrollment"],
  ["I've sent your request to the team.", "unverified_request_submission"],
  ["Your request is under review.", "unverified_request_submission"],
  ["I've alerted the team.", "unverified_owner_alert"],
  ["You're booked for Wednesday.", "unverified_appointment_confirmation"],
])("blocks unsupported actions while retaining useful scheduling language: %s", (reply, violation) => {
  const result = sanitizeOutboundReply({ reply, actionType: "collect_appointment_preference", category: "appointment_preference", capabilities: {}, actionEvidence: {}, addDisclosure: false });
  expect(result.usedFallback).toBe(true);
  expect(result.violations).toContain(violation);
});


test.each([
  [true, true, /offers emergency service/],
  [false, true, /does not offer emergency service/],
  [true, false, /don’t have verified/],
  ["yes", true, /don’t have verified/],
])("emergency capability uses verified boolean evidence (%s, %s)", (value, verified, expected) => {
  const reply = schedulingQuestionReply({ customerMessage: "Is there an emergency time?", business: { aiKnowledge: { verifiedFacts: { emergencyServiceAvailable: { value, verified } } } } });
  expect(reply).toMatch(expected);
  expect(reply).not.toMatch(/we can come|on the way|confirmed for/i);
});

test("a connected calendar does not authorize claims by the text-only model", async () => {
  create.mockResolvedValue({ output_text: JSON.stringify({ ...modelReply, reply: "Your appointment is booked and confirmed for Wednesday." }) });
  const configured = { ...business, aiCapabilities: { canConfirmAppointment: true }, integrations: { calendar: { status: "connected", verified: true } } };
  const result = await generateAIReplyResult({ business: configured, lead: { serviceNeeded: "sink clog" }, messages: [{ direction: "inbound", body: "Kitchen sink is clogged and dishwasher leaks" }] });
  expect(result.guardrail.violations).toContain("unverified_appointment_confirmation");
  const input = JSON.parse(create.mock.calls[0][0].input);
  expect(input.capabilities.canConfirmAppointment).toBe(false);
  expect(input.operationalFacts.completedActionsThisTurn).toEqual([]);
});

test('toilet intake passes through the actual SMS reply pipeline with persistent context', async () => {
  const lead = { _id: 'lead-1', serviceNeeded: 'Unknown', urgency: 'medium', save: jest.fn().mockResolvedValue(null) };
  const conversation = { _id:'conversation-1', status:'open', bookingState:{status:'not_started'}, conversationMemory:{}, save:jest.fn().mockResolvedValue(null), set(path,value){this.conversationMemory[path.split('.')[1]]=value;} };
  const messages=[];
  const turn=async body=>{ messages.push({_id:String(messages.length),direction:'inbound',body}); return generateAIReplyResult({business,lead,conversation,messages,customerMessage:body}); };
  searchServices.mockResolvedValue([{id:'service-1',name:'Toilet repair'}]);
  // Area validation uses the provider boundary too; covered with configured-area cases in the shared suite.
  const first=await turn('My toilet is stopped up and leaking around the seal'); expect(first.reply).toMatch(/right now/);
  await turn('Only when the toilet is used'); await turn('Sep 8'); await turn('8 am');
  const status=await turn('When will it be confirmed'); expect(status.reply).toMatch(/confirmation timeframe/);
  expect(lead.preferredAppointmentTime).toBe('2026-09-08 at 8:00');
  expect(create).not.toHaveBeenCalled(); expect(createAppointment).not.toHaveBeenCalled();
});


test.each([
  ["My kitchen sink is clogged and dish washer is leaking water. When can someone come out", "medium"],
  ["My kitchen sink is clogged and dishwasher is actively leaking right now. When can someone come out", "high"],
])('scheduling keeps evidence-based urgency for %s', async (body, urgency) => {
  const result = await generateAIReplyResult({ business, lead: { serviceNeeded: "Unknown", urgency: "medium" }, conversation: { bookingState: { status: "not_started" } }, messages: [{ direction: "inbound", body }] });
  expect(result.urgency).toBe(urgency);
  expect(createAppointment).not.toHaveBeenCalled();
});
