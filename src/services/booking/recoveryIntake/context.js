import { applyBookingStateTransition } from '../requestBookingState.js';

import { isContextualSymptomAnswer } from '../contextualServiceAnswer.service.js';

import BookingStateMachine, { selectOfferedSlot } from '../bookingStateMachine.service.js';

import { classifyLeakActivityAnswer } from '../leakActivityAnswer.service.js';

import { assessTradeQualification, tradeReviewReply } from '../../trades/tradeQualification.service.js';

import { leakContext } from '../../trades/tradeProfiles.service.js';

import { confirmationFollowUpReply } from '../confirmationFollowUp.service.js';

import { schedulingEvidence } from '../schedulingEvidence.service.js';

import { completionClarification, updateRequestQuestions, normalizeRequestService } from '../requestQuestionPolicy.service.js';

import { assessProblemClarity, buildRequestReadiness, requestEvidenceKey } from "../requestQualificationPolicy.service.js";

import { extractCustomerAddress, addressFromTurn, resolveRequestAddress, isRepeatCorrection, extractCustomerPostalCode } from '../customerAddress.service.js';

import { isSoftOptOutPhrase } from '../../messaging/smsCompliance.service.js';

import { guardServiceRequest } from '../../serviceEligibility/serviceEligibility.service.js';

import { patternHasAffirmedSafetyMatch, getEmergencyReply, isUrgentPlumbingRequest } from '../../../helpers/ai/aiGuardrails.js';

import { requestStaffSchedulingReview } from "../staffSchedulingReview.service.js";

import { recoveryLeakQuestion, recoveryCompletionReply } from '../recoveryIntakePresentation.service.js';

import { getApprovedServiceEstimate } from '../approvedServiceEstimate.service.js';

import { logOperationalError } from '../../../helpers/logging/safeLogger.js';

import { pricingReply } from '../../messaging/smsTurnPolicy.service.js';

import { classifySmsIntent } from '../../messaging/smsIntentClassifier.service.js';

import { findDateRange, parseTimePreference, formatTimePreferenceLabel, filterSlotsByTimePreference } from '../appointmentPreferenceParser.service.js';

import searchServices from '../../../helpers/ai/tools/searchServices.tool.js';

import getAvailability from '../../../helpers/ai/tools/getAvailability.tool.js';

import validateServiceArea from '../../../helpers/ai/tools/validateServiceArea.tool.js';

import AlertService from '../../alert.service.js';

import { isCoverageQuestion, coverageReviewReply, currentCoverage } from '../coverageConversation.service.js';

import { isConfirmationQuestion } from '../conversationQuestions.service.js';

import { assertDistributedLeaseActive } from '../../distributedLease.service.js';

import { assertVoiceTurnActive } from '../../voiceTurnContext.service.js';

import { resetUncertainTurns } from '../../messaging/uncertainReply.service.js';

import { filterAutomatedSlots } from '../../scheduling/automatedSchedulingPolicy.service.js';

import { formatDateKey } from '../../scheduling/timezone.service.js';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

const known = value => clean(value) && !/^(unknown|not provided|n\/a)$/i.test(clean(value));

const leak = /\b(?:leak(?:ing|s)?|overflow(?:ing)?|water spreading)\b/i;

const active = /\b(?:(?:actively|still|currently) (?:leaking|overflowing)|(?:leaking|overflowing) (?:right now|constantly|continuously|nonstop|all the time)|(?:constantly|continuously) (?:leaking|overflowing)|won't stop leaking|will not stop leaking|overflowing|spreading|gushing|flooding)\b/i;

const stopped = /\b(?:(?:not|isn['’]?t|aren['’]?t|no longer|stopped) (?:(?:actively|currently|still) )?(?:leaking|overflowing|flooding|spreading|gushing)|(?:doesn['’]?t|does not) (?:leak|overflow)|no (?:active )?(?:leak(?:ing|s)?|overflow(?:ing)?|flooding)|(?:leak(?:ing)?|overflow(?:ing)?) (?:has )?stopped|only when|only (?:leaks|leaking|overflows|overflowing))\b/i;

const controlMessage = /^(?:stop|unsubscribe|help|start|unstop)[.! ]*$/i;

const clogQuestion = 'Is water overflowing or backing up into other fixtures?';

const noOverflowStated = value => /\b(?:not|isn['’]?t|no|without)\s+(?:[a-z]+\s+){0,3}(?:overflow(?:ing)?|flood(?:ing|ed)?)\b/i.test(clean(value));

const clogQuestionFor = context => noOverflowStated(context)
  ? 'Thanks, I noted it is not overflowing. Is it backing up into any other sinks, tubs, or toilets?'
  : clogQuestion;

const cloggedFixture = value => /\b(?:clogged|blocked|stopped up)\b/i.test(value) && /\b(?:toilet|sink|drain|tub|shower|sewer)\b/i.test(value);

const businessHoursQuestion = /\b(?:what (?:are|time)|when (?:are|do|will)).{0,35}\b(?:hours|open|close)\b/i;

const addressFrom = extractCustomerAddress;

const fixed = (reply, lead, extra = {}) => ({
  decision: 'send_fixed_response', actionType: 'request_information', messageCategory: 'service_request',
  reply, serviceNeeded: lead.serviceNeeded || '', urgency: lead.urgency || 'medium', address: lead.address || '',
  preferredAppointmentTime: lead.preferredAppointmentTime || '', shouldAlertOwner: false, riskFlags: [],
  guardrail: { skipAI: true, usedFallback: false, reason: 'shared_recovery_intake' }, intakeReady: false, ...extra,
});

const confirmationTimingReply = ({ lead = {}, conversation = {}, channel = 'sms' } = {}) => {
  const reply = confirmationFollowUpReply({ lead, conversation, channel });
  return reply + (currentCoverage(conversation, lead)?.supported === null ? ' Service-area coverage still needs team review.' : '') +
    (!known(lead.address) ? ' What is the service address?' : '');
};

const slotLabel = (slot, timezone) => new Intl.DateTimeFormat('en-US', {
  timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(slot.startAt));

export { AlertService, BookingStateMachine, active, addressFrom, addressFromTurn, applyBookingStateTransition, assertDistributedLeaseActive, assertVoiceTurnActive, assessProblemClarity, assessTradeQualification, buildRequestReadiness, businessHoursQuestion, classifyLeakActivityAnswer, classifySmsIntent, clean, clogQuestionFor, cloggedFixture, completionClarification, confirmationTimingReply, controlMessage, coverageReviewReply, extractCustomerPostalCode, filterAutomatedSlots, filterSlotsByTimePreference, findDateRange, fixed, formatDateKey, formatTimePreferenceLabel, getApprovedServiceEstimate, getAvailability, getEmergencyReply, guardServiceRequest, isConfirmationQuestion, isContextualSymptomAnswer, isCoverageQuestion, isRepeatCorrection, isSoftOptOutPhrase, isUrgentPlumbingRequest, known, leak, leakContext, logOperationalError, normalizeRequestService, parseTimePreference, patternHasAffirmedSafetyMatch, pricingReply, recoveryCompletionReply, recoveryLeakQuestion, requestEvidenceKey, requestStaffSchedulingReview, resetUncertainTurns, resolveRequestAddress, schedulingEvidence, searchServices, selectOfferedSlot, slotLabel, stopped, tradeReviewReply, updateRequestQuestions, validateServiceArea };
