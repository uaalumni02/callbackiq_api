// This suite isolates downstream orchestration. The actual catalog/tenant gate is
// exercised by serviceEligibility.journey.test.js and the configured channel journeys.
jest.mock('../../src/services/serviceEligibility/serviceEligibility.service.js', () => ({
  ...jest.requireActual('../../src/services/serviceEligibility/serviceEligibility.service.js'),
  guardServiceRequest: jest.fn().mockResolvedValue(null),
  assertServiceRequestEligible: jest.fn().mockResolvedValue({ decision: 'supported', canBook: true }),
}));
import { getApprovedServiceEstimate } from '../../src/services/booking/approvedServiceEstimate.service.js';
jest.mock('../../src/services/booking/approvedServiceEstimate.service.js', () => ({ getApprovedServiceEstimate: jest.fn().mockResolvedValue('') }));
import {
  SAFE_REPLIES,
  cleanText,
  evaluateDeterministicInboundGuardrails,
  normalizeSmsReply,
} from "../../src/helpers/ai/aiGuardrails.js";
import {
  getOpenAIClient,
  resetFollowUpOpenAIClient,
  runFollowUpAgent,
} from "../../src/helpers/ai/followUpAgent.js";
import {
  qualifyLeadWithAI,
  resetQualificationOpenAIClient,
} from "../../src/helpers/ai/qualifyLeadWithAI.js";
import {
  fallbackReply,
  generateAIReply,
  generateAIReplyResult,
  resetOpenAIReplyClient,
} from "../../src/services/aiReplyService.js";
import { buildAIConfigurationContext } from "../../src/services/businessConfiguration.service.js";
import BookingStateMachineService from "../../src/services/booking/bookingStateMachine.service.js";
import { reserveAiUsage } from "../../src/services/communicationUsage.service.js";
import { logOperationalError } from "../../src/helpers/logging/safeLogger.js";

jest.mock("../../src/helpers/ai/aiGuardrails.js", () => ({
  ...jest.requireActual("../../src/helpers/ai/aiGuardrails.js"),
  __esModule: true,
  SAFE_REPLIES: { fallback: "Safe fallback reply." },
  cleanText: jest.fn((value, fallback = "") => {
    const text = String(value ?? "").trim();
    return text || fallback;
  }),
  evaluateDeterministicInboundGuardrails: jest.fn(),
  normalizeSmsReply: jest.fn((reply, fallback) => String(reply || fallback).trim()),
}));
jest.mock("../../src/helpers/ai/followUpAgent.js", () => ({
  __esModule: true,
  getOpenAIClient: jest.fn(),
  resetFollowUpOpenAIClient: jest.fn(),
  runFollowUpAgent: jest.fn(),
}));
jest.mock("../../src/helpers/ai/qualifyLeadWithAI.js", () => ({
  __esModule: true,
  qualifyLeadWithAI: jest.fn(),
  resetQualificationOpenAIClient: jest.fn(),
}));
jest.mock("../../src/services/businessConfiguration.service.js", () => ({
  __esModule: true,
  buildAIConfigurationContext: jest.fn(),
}));
jest.mock("../../src/services/booking/bookingStateMachine.service.js", () => ({
  __esModule: true,
  default: { handle: jest.fn() },
}));

jest.mock("../../src/services/communicationUsage.service.js", () => ({
  __esModule: true,
  reserveAiUsage: jest.fn(),
}));
jest.mock("../../src/helpers/logging/safeLogger.js", () => ({
  __esModule: true,
  logOperationalError: jest.fn(),
}));
import { handleRecoveryIntake } from '../../src/services/booking/recoveryIntake.service.js';
import { evaluateSmsTurnPolicy } from '../../src/services/messaging/smsTurnPolicy.service.js';
jest.mock('../../src/services/booking/recoveryIntake.service.js', () => ({ handleRecoveryIntake: jest.fn() }));
jest.mock('../../src/services/messaging/smsTurnPolicy.service.js', () => ({ evaluateSmsTurnPolicy: jest.fn(), applySmsTurnPolicy: jest.fn(({ result }) => result) }));

const business = { _id: 'b1', businessType: 'plumbing' };
const assessment = { decision: 'send', messageCategory: 'pricing_request', isInScope: true, confidence: 94, serviceNeeded: 'bath enclosure weather seal replacement', riskFlags: [] };
const genericPricing = { directResult: { reply: 'What service?', serviceNeeded: '' }, intent: { pricing: true }, serviceNeeded: '' };
beforeEach(() => {
  jest.clearAllMocks();
  getApprovedServiceEstimate.mockResolvedValue('');
  evaluateDeterministicInboundGuardrails.mockReturnValue({ handled: false });
  handleRecoveryIntake.mockResolvedValue(null);
  BookingStateMachineService.handle.mockResolvedValue({ handled: false });
  reserveAiUsage.mockResolvedValue({ allowed: true });
  qualifyLeadWithAI.mockResolvedValue(assessment);
  buildAIConfigurationContext.mockResolvedValue({});
  evaluateSmsTurnPolicy.mockReturnValue(genericPricing);
  runFollowUpAgent.mockResolvedValue({ decision: 'send', confidence: 90, reply: 'What is the service address?' });
});

test('unknown service plus pricing uses existing metered semantic extraction and shared intake before reply generation', async () => {
  const expected = { decision: 'send_fixed_response', reply: 'Pricing needs scope review. What is the service address?', serviceNeeded: assessment.serviceNeeded };
  handleRecoveryIntake.mockImplementation(async ({ semanticAssessment }) => semanticAssessment ? expected : null);
  const result = await generateAIReplyResult({ business, lead: {}, customerMessage: 'Weather seal round the enclosure. How much?' });
  expect(result).toEqual(expected);
  expect(reserveAiUsage).toHaveBeenCalledTimes(1);
  expect(qualifyLeadWithAI).toHaveBeenCalledTimes(1);
  expect(handleRecoveryIntake).toHaveBeenLastCalledWith(expect.objectContaining({ semanticAssessment: assessment }));
  expect(runFollowUpAgent).not.toHaveBeenCalled();
});

test('denied AI budget never invokes semantic extraction or the reply model', async () => {
  reserveAiUsage.mockResolvedValue({ allowed: false, reason: 'AI_USAGE_LIMIT' });
  const result = await generateAIReplyResult({ business, lead: {}, customerMessage: 'Weather seal round the enclosure. How much?' });
  expect(result.guardrail.reason).toBe('AI_USAGE_LIMIT');
  expect(qualifyLeadWithAI).not.toHaveBeenCalled();
  expect(runFollowUpAgent).not.toHaveBeenCalled();
});

test('safety preempts both deterministic and semantic intake', async () => {
  evaluateDeterministicInboundGuardrails.mockReturnValue({ handled: true, category: 'emergency', decision: 'send_fixed_response', reply: 'Move away from the hazard.' });
  await generateAIReplyResult({ business, lead: {}, customerMessage: 'Gas smell near the bathtub. How much?' });
  expect(handleRecoveryIntake).not.toHaveBeenCalled();
  expect(BookingStateMachineService.handle).not.toHaveBeenCalled();
  expect(reserveAiUsage).not.toHaveBeenCalled();
});

test('low confidence qualification does not bootstrap service facts or overwrite existing service', async () => {
  qualifyLeadWithAI.mockResolvedValue({ ...assessment, confidence: 15 });
  await generateAIReplyResult({ business, lead: {}, customerMessage: 'Can you help with it? How much?' });
  expect(handleRecoveryIntake).toHaveBeenCalledTimes(1);
  expect(runFollowUpAgent).toHaveBeenCalledWith(expect.objectContaining({ lead: {} }));
});

test.each(['pricing_request', 'appointment_preference', 'human_requested', 'appointment_cancellation'])('approved prices preserve the %s action', async messageCategory => {
 getApprovedServiceEstimate.mockResolvedValue('The rough estimate is $125-$250. Final pricing depends on technician evaluation.');
 const reply='Your request is saved. This is not a confirmed appointment.';
 evaluateSmsTurnPolicy.mockReturnValue({ intent: { pricing: true }, serviceNeeded: 'AC repair', directResult: { messageCategory, reply, serviceNeeded: 'AC repair' } });
 const result=await generateAIReplyResult({ business, lead: { _id:'l1', serviceNeeded:'AC repair' }, conversation: { _id:'c1' }, messages: [{direction:'inbound',body:'How much for AC repair?'}] });
 expect(result.messageCategory).toBe(messageCategory);
 if (['pricing_request','appointment_preference'].includes(messageCategory)) expect(result.reply).toContain('$125-$250');
 else { expect(result.reply).toBe(reply); expect(getApprovedServiceEstimate).not.toHaveBeenCalled(); }
 if (messageCategory === 'appointment_preference') expect(result.reply).toContain('not a confirmed appointment');
});
