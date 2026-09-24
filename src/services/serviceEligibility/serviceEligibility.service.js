import { assessProblemClarity } from "../booking/requestQualificationPolicy.service.js";
import { isRequestWithdrawal, requestWasWithdrawn } from '../conversationControlPolicy.js';
import { extractCustomerAddress, addressFromTurn, isAddressOnlyTurn } from '../booking/customerAddress.service.js';
import { isSoftOptOutPhrase } from '../messaging/smsCompliance.service.js';
import { staffReviewDueAt } from '../staffReviewPolicy.service.js';
import crypto from 'crypto';
import ServiceOffering from '../../models/serviceOffering.js';
import BusinessOperationsSettings from '../../models/businessOperationsSettings.js';
import Lead from '../../models/lead.js';
import Conversation from '../../models/conversation.js';
import AlertService from '../alert.service.js';
import { classifySmsIntent, extractService } from '../messaging/smsIntentClassifier.service.js';
import { evaluateDeterministicInboundGuardrails } from '../../helpers/ai/aiGuardrails.js';
import { qualifyLeadWithAI } from '../../helpers/ai/qualifyLeadWithAI.js';
import { reserveAiUsage } from '../communicationUsage.service.js';
import { assertVoiceTurnActive } from '../voiceTurnContext.service.js';
import { assertDistributedLeaseActive } from '../distributedLease.service.js';
import { evaluateServicePolicy, eligibilityReply, serviceDomains, blocksServiceAutomation } from './policy.js';
import { additionalServiceText } from '../messaging/customerTurnPlan.service.js';
import { preserveAdditionalServiceRequest } from './additionalServiceRequest.service.js';

const clean = value => String(value || '').trim();
const known = value => clean(value) && !/^(unknown|not provided|n\/a)$/i.test(clean(value));
const checkActive = () => { assertVoiceTurnActive(); assertDistributedLeaseActive(); };
export { blocksServiceAutomation } from './policy.js';

export async function evaluateServiceEligibility({ businessId, request, semanticService = '', confidence = 0 }) {
  const [services, settings] = await Promise.all([
    ServiceOffering.find({ business: businessId, active: true }).lean(),
    BusinessOperationsSettings.findOne({ business: businessId }).lean(),
  ]);
  const result = evaluateServicePolicy({ request, services, policy: settings?.serviceEligibilityPolicy || {}, semanticService, confidence });
  if (result.decision === 'supported' && settings?.aiPermissions?.canDiscussServices === false) return { ...result, decision: 'needs_staff_review', reason: 'business_discussion_requires_staff' };
  return result;
}

export async function guardServiceRequest({ business, lead, conversation, customerMessage, semanticAssessment = null, channel = 'sms', turnId = '', recentMessages = [] }) {
  const text = clean(customerMessage);
  if (!business?._id || !conversation || !text || conversation.humanTakeover || conversation.aiEnabled === false || ['closed', 'archived'].includes(conversation.status)) return null;
  // Safety, consent and abuse controls retain precedence even when called by a lower-level entry point.
  if (isRequestWithdrawal(text) || requestWasWithdrawn(conversation)) return null;
  if (isSoftOptOutPhrase(text) || evaluateDeterministicInboundGuardrails({ customerMessage: text }).handled) return null;
  const additionalRequest = additionalServiceText(text, lead, conversation);
  if (additionalRequest) {
    const additional = await preserveAdditionalServiceRequest({ request: additionalRequest, business, lead, conversation,
      customerMessage: text, evaluate: evaluateServiceEligibility });
    if (additional) return additional;
  }
  if (conversation.bookingState?.appointment && /\b(?:cancel|reschedule|move|status of)\b.{0,80}\b(?:appointment|booking|visit)\b/i.test(text)) return null;
  const intent = classifySmsIntent({ business, lead, conversation, customerMessage: text });
  let current = extractService(text, { lead, conversation });
  const prior = conversation.serviceEligibility || lead?.serviceEligibility;
  if (!current && !prior?.request && !known(lead?.serviceNeeded) && !intent.intents?.scheduling &&
      semanticAssessment?.serviceNeeded && semanticAssessment?.confidence >= 60) current = text;
  const hasDomain = serviceDomains(text).length > 0;
  // Symptom updates answer triage; they do not request an unidentified new service.
  if (!hasDomain && (prior?.request || known(lead?.serviceNeeded)) &&
      /^(?:(?:it |the leak )?(?:has )?)?(?:not|no longer|stopped|only when|only during)\b/i.test(text)) current = '';
  const triageAnswer = /^(?:no|nope|yes|yeah|yep)[, ]|^(?:only|just) (?:the|my|this) /i.test(text) &&
    (conversation.conversationMemory?.recoveryIntake?.clogPending ||
      conversation.conversationMemory?.recoveryIntake?.triageAnswer === text ||
      /^(?:no[, ]+)?(?:only|just) (?:the|my|this) /i.test(text) && known(lead?.serviceNeeded)) && !current;
  if (!current && hasDomain && !isAddressOnlyTurn(text) && !triageAnswer) current = text;
  const clarificationAnswer = prior?.decision === 'needs_clarification' &&
    !['cancel', 'reschedule', 'status', 'human', 'callback'].some(key => intent.intents?.[key]);
  if (clarificationAnswer && /\b(?:unsure|not sure|don['’]?t know)\b/i.test(text)) current = `unsure: ${prior.request}`;
  // Existing appointments and general questions remain manageable; no new work is implied.
  if (!current && !clarificationAnswer && ['cancel', 'reschedule', 'status', 'human', 'callback', 'businessHours'].some(key => intent.intents?.[key])) return null;
  if (!current && /\b(?:hours|open|close|phone number|email|payment|invoice|warranty)\b/i.test(text)) return null;
  if (!current && /^(?:thanks|thank you|ok|okay|hi|hello|bye)[!. ]*$/i.test(text)) return null;
  if (!current && conversation.bookingState?.appointment && !blocksServiceAutomation(conversation)) return null;
  const acceptingReview = prior?.decision === 'needs_staff_review' && (intent.response.affirmative ||
    /\b(?:submit|send|save)\b.{0,30}\b(?:request|review|team|staff)\b/i.test(text) ||
    /\b(?:can|could|please|want to|like to)\b.{0,25}\b(?:schedule|book|appointment)\b/i.test(text)) && !intent.response.negative;
  const decliningReview = prior?.decision === 'needs_staff_review' && /^(?:no|nope|no thanks)\b/i.test(text);
  // Pronouns and slot answers keep the previously checked service rather than becoming a new job.
  if (current && /^(?:it|that|this)\b/i.test(current) && prior?.request) current = '';
  let request = current || prior?.request || (known(lead?.serviceNeeded) ? lead.serviceNeeded : '');
  if (!request && intent.intents?.pricing && !semanticAssessment) return null;
  if (!request && !intent.intents?.scheduling && !intent.intents?.pricing && !intent.intents?.availabilityInquiry) return null;
  let eligibility;
  let semanticService = (current ? semanticAssessment?.serviceNeeded : '') || (prior?.request === request ? prior.semanticService : '') || '';
  let confidence = (current ? semanticAssessment?.confidence : 0) || (prior?.request === request ? prior.semanticConfidence : 0) || 0;
  // Explicit customer corrections outrank a model's older interpretation,
  // including corrections that still map to the same catalog offering.
  const serviceCorrection = Boolean(current && intent.intents?.correction);
  if (serviceCorrection) { semanticService = ''; confidence = 0; }
  try {
    eligibility = await evaluateServiceEligibility({ businessId: business._id, request,
      semanticService, confidence });
    // Reuse the metered, schema-validated interpreter for unfamiliar first-turn wording.
    if (current && !semanticAssessment && ['catalog_incomplete', 'unrecognized_service'].includes(eligibility.reason) && prior?.request !== request) {
      const usage = await reserveAiUsage({ business, customerPhone: lead?.phone || conversation.customerPhone || '' });
      if (usage.allowed) {
        const understood = await qualifyLeadWithAI({ business, messageBody: text });
        checkActive();
        if (!understood.guardrail?.usedFallback && !(understood.riskFlags?.length) && understood.isInScope === true) {
          semanticService = understood.serviceNeeded; confidence = understood.confidence;
          eligibility = await evaluateServiceEligibility({ businessId: business._id, request,
            semanticService: understood.serviceNeeded, confidence: understood.confidence });
        }
      }
    }
  } catch (error) {
    if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
    eligibility = { decision: 'needs_staff_review', reason: 'catalog_unavailable', request, serviceId: null };
  }
  checkActive();
  const changed = Boolean(serviceCorrection && known(lead?.serviceNeeded) && lead.serviceNeeded !== current) || Boolean(prior && (prior.serviceId !== eligibility.serviceId || prior.decision !== eligibility.decision ||
    (prior.request !== request && (eligibility.decision !== 'supported' || intent.intents?.correction || intent.intents?.newService))));
  const reviewSubmitted = !changed && prior?.reviewSubmitted === true;
  const state = { ...eligibility, semanticService, semanticConfidence: confidence, checkedAt: new Date(), reviewSubmitted };
  conversation.serviceEligibility = state;
  conversation.markModified?.('serviceEligibility');
  if (lead) {
    lead.serviceEligibility = state;
    lead.markModified?.('serviceEligibility');
    if (current && (!known(lead.serviceNeeded) || changed || serviceCorrection || eligibility.decision !== 'supported')) lead.serviceNeeded = (!serviceCorrection && eligibility.decision === 'supported' && semanticService && confidence >= 80 ? semanticService : current).slice(0, 200);
  }
  if (changed || (!prior && eligibility.decision !== 'supported')) {
    // Invalidate stale proposals, never cancel an existing customer appointment.
    if (!conversation.bookingState?.appointment) conversation.bookingState = { status: 'not_started' };
    const memory = conversation.conversationMemory?.toObject?.() || conversation.conversationMemory || {};
    conversation.conversationMemory = { ...memory, recoveryIntake: current && prior?.request !== request ? {} : (memory.recoveryIntake || {}) };
    if (current && prior?.request !== request) {
      conversation.conversationMemory.serviceNeeded = lead?.serviceNeeded || current;
      conversation.conversationMemory.summary = lead?.serviceNeeded || current;
    }
    conversation.markModified?.('conversationMemory');
    if (conversation.lifecycle) conversation.lifecycle.nextRecoveryNudgeAt = null;
    if (lead && !lead.bookedAt && !lead.appointment) {
      lead.qualifiedAt = null;
      lead.leadQualityScore = 0;
      if (lead.valuation?.source !== 'owner') {
        lead.estimatedValue = null;
        lead.valuation = { source: 'unknown', basis: 'Service eligibility is not verified.', updatedAt: new Date() };
      }
      lead.valuationVersion = Number(lead.valuationVersion || 0) + 1;
    }
  }
  // Keep facts even while service acceptance needs review. No price/calendar action is authorized.
  if (lead && eligibility.decision === 'needs_staff_review') {
    const address = addressFromTurn({customerMessage:text, recentMessages, conversation, knownAddress: known(lead.address) ? lead.address : ''}) || extractCustomerAddress(text, { expected: Boolean(reviewSubmitted || acceptingReview) });
    if (address) lead.address = address;
    else if (/^\d{5}(?:-\d{4})?$/.test(text) && known(lead.address) && !/\b\d{5}\b/.test(lead.address)) lead.address += `, ${text}`;
    if (!address && !intent.intents?.availabilityInquiry && (intent.entities?.range || intent.entities?.timePreference?.timeOfDay || intent.entities?.timePreference?.targetMinutes != null)) {
      lead.preferredAppointmentTime = text.slice(0, 500);
    }
  }
  checkActive();
  if (typeof lead?.save === 'function') await lead.save();
  checkActive();
  if (typeof conversation.save === 'function') await conversation.save();
  if (eligibility.decision === 'supported') return null;
  let reply = eligibilityReply(eligibility, business.businessName);
  if (eligibility.decision === 'needs_staff_review' && (acceptingReview || reviewSubmitted)) {
    // Stable key makes a retry repair an interrupted alert write without duplicating it.
    checkActive();
    const reviewAlert = await AlertService.create({ businessId: business._id, leadId: lead?._id, conversationId: conversation._id, type: 'system',
      actionRequired: true, dueAt: staffReviewDueAt('medium'), reason: eligibility.reason, recommendedAction: 'Determine whether this business accepts the requested service before quoting or scheduling.', title: 'Service eligibility needs review',
      message: `Determine whether this business accepts the requested work: ${request.slice(0, 300)}. Reason: ${eligibility.reason}. No appointment or callback time was promised.`,
      priority: 'medium', dedupeKey: `service-eligibility:${conversation._id}:${crypto.createHash('sha256').update(request).digest('hex').slice(0, 32)}`,
      metadata: { leadId: String(lead?._id || ''), conversationId: String(conversation._id), serviceEligibilityReason: eligibility.reason, channel } });
    if (!reviewAlert?.alert?._id) throw Object.assign(new Error('Service review could not be saved.'), { code: 'SERVICE_REVIEW_NOT_SAVED' });
    state.reviewSubmitted = true;
    checkActive();
    if (lead) { lead.serviceEligibility = state; lead.markModified?.('serviceEligibility'); await lead.save?.(); }
    conversation.serviceEligibility = state; conversation.markModified?.('serviceEligibility'); await conversation.save?.();
    const next = !known(lead?.address) ? ' If you want staff to review it, what is the service address?' :
      !/\b\d{5}(?:-\d{4})?\b/.test(lead.address) ? ' What is the ZIP code for that address?' : '';
    reply = `${intent.intents?.pricing ? "I don't have an approved estimate for this request yet. " : ''}Your request is saved for staff to review whether they can accept the work. Pricing and scheduling stay paused until staff confirms the service is accepted. No appointment is confirmed.${next}`;
  } else if (decliningReview) reply = "Understood. I won't submit a staff review request or arrange an appointment for this work.";
  return { decision: 'send_fixed_response', actionType: 'send_fixed_response', messageCategory: 'service_request',
    reply, serviceEligibility: state, serviceNeeded: lead?.serviceNeeded || request.slice(0, 200),
    address: lead?.address || '', preferredAppointmentTime: lead?.preferredAppointmentTime || '',
    urgency: lead?.urgency || 'medium', leadQualityScore: 0, intakeReady: false, shouldAlertOwner: false,
    riskFlags: [], guardrail: { skipAI: true, reason: 'service_eligibility', usedFallback: false } };
}

// Tool and persistence boundaries validate the selected offering against the actual request again.
export async function assertServiceRequestEligible({ businessId, leadId, conversationId, serviceOfferingId, request = '', allowStaffReview = false }) {
  if (!businessId || (!leadId && !conversationId)) {
    throw Object.assign(new Error('A saved service request is required before scheduling.'), { code: 'SERVICE_ELIGIBILITY_REQUIRED', statusCode: 409 });
  }
  const [lead, conversation] = await Promise.all([
    leadId ? Lead.findOne({ _id: leadId?._id || leadId, business: businessId }).lean() : null,
    conversationId ? Conversation.findOne({ _id: conversationId?._id || conversationId, business: businessId }).lean() : null,
  ]);
  if (requestWasWithdrawn(conversation)) throw Object.assign(new Error('The customer withdrew this service request.'), { code: 'SERVICE_REQUEST_WITHDRAWN', statusCode: 409 });
  const state = conversation?.serviceEligibility || lead?.serviceEligibility;
  if ((leadId && !lead) || (conversationId && !conversation)) throw Object.assign(new Error('Service request context was not found.'), { code: 'SERVICE_CONTEXT_NOT_FOUND', statusCode: 404 });
  // Tool arguments cannot replace the customer's saved request with a permitted service.
  const actualRequest = state?.request || (known(lead?.serviceNeeded) ? lead.serviceNeeded : '');
  const eligibility = await evaluateServiceEligibility({ businessId, request: actualRequest || '', semanticService: state?.semanticService || '', confidence: state?.semanticConfidence || 0 });
  if ((!allowStaffReview && eligibility.canBook !== true) || (eligibility.decision !== 'supported' && !(allowStaffReview && eligibility.decision === 'needs_staff_review' && eligibility.serviceId)) ||
      String(eligibility.serviceId || '') !== String(serviceOfferingId?._id || serviceOfferingId || '')) {
    throw Object.assign(new Error('Review the requested service before pricing or scheduling.'), { code: 'SERVICE_ELIGIBILITY_REQUIRED', statusCode: 409, eligibility });
  }
  if (!allowStaffReview) {
    const intake = conversation?.conversationMemory?.recoveryIntake || {};
    const problem = assessProblemClarity({ service: lead?.serviceNeeded || actualRequest, text: '',
      previous: intake.problem, policy: eligibility.intakePolicy, category: eligibility.category,
      interrupt: true });
    if (problem.status !== 'clear' || intake.triagePending || intake.clogPending) {
      throw Object.assign(new Error('Clarify the customer problem before offering or creating an appointment.'), {
        code: 'REQUEST_QUALIFICATION_REQUIRED', statusCode: 409, problem,
      });
    }
  }
  return eligibility;
}
