const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const known = value => clean(value) && !/^(unknown|not provided|n\/a)$/i.test(clean(value));
const FACT_CATEGORIES = new Set(['new_service_request', 'service_request', 'service_details', 'appointment_preference', 'pricing_request']);

// Qualification confidence concerns the customer's facts. Reply confidence concerns
// the proposed wording/action: a weak reply must not erase independently extracted facts.
export const qualifiedIntakeFacts = assessment => {
  if (!assessment || assessment.isInScope !== true || !Number.isFinite(assessment.confidence) ||
      assessment.confidence < 60 || assessment.skipAI ||
      !FACT_CATEGORIES.has(assessment.messageCategory) ||
      !['send', 'send_ai_response'].includes(assessment.decision) ||
      assessment.riskFlags?.length) return {};
  const facts = {};
  for (const field of ['serviceNeeded', 'address', 'preferredAppointmentTime']) {
    if (known(assessment[field])) facts[field] = clean(assessment[field]).slice(0, 500);
  }
  return facts;
};

const setMemory = (conversation, field, value) => {
  if (conversation.set) conversation.set(`conversationMemory.${field}`, value);
  else conversation.conversationMemory = { ...(conversation.conversationMemory || {}), [field]: value };
};

export const resetUncertainTurns = async conversation => {
  if (!conversation?.conversationMemory?.uncertainTurns || typeof conversation.save !== 'function') return;
  setMemory(conversation, 'uncertainTurns', 0);
  setMemory(conversation, 'uncertainTurnId', '');
  await conversation.save();
};

export const constrainUncertainReply = async ({ result, lead, conversation, turnId = '', inboundAssessment = null }) => {
  if (!result || result.decision === 'no_reply' || result.guardrail?.skipAI === true || result.guardrail?.usedFallback) return result;
  const extracted = qualifiedIntakeFacts(inboundAssessment);
  const facts = Object.fromEntries(['serviceNeeded', 'address', 'preferredAppointmentTime'].map(field => [field, extracted[field] || (known(lead?.[field]) ? clean(lead[field]) : '')]));
  const replyCertain = Number.isFinite(result.confidence) && result.confidence >= 60;
  const factsAdvanced = Object.entries(extracted).some(([field, value]) => value !== clean(lead?.[field]));
  if (replyCertain || factsAdvanced) {
    if (conversation?.conversationMemory?.uncertainTurns && typeof conversation.save === 'function') {
      setMemory(conversation, 'uncertainTurns', 0);
      setMemory(conversation, 'uncertainTurnId', '');
      await conversation.save();
    }
    if (replyCertain) {
      const preserved = { ...result };
      for (const [field, value] of Object.entries(extracted)) {
        if (!known(preserved[field])) preserved[field] = value;
      }
      return preserved;
    }
  }
  // Missing/non-numeric confidence also cannot authorize a model-generated action.
  // Legacy callers with no confidence field retain their existing result contract.
  if (result.confidence === undefined) return result;
  const memory = conversation?.conversationMemory || {};
  const count = factsAdvanced ? 0 : turnId && memory.uncertainTurnId === String(turnId)
    ? Number(memory.uncertainTurns || 1)
    : Math.min(2, Number(memory.uncertainTurns || 0) + 1);
  if (typeof conversation?.save === 'function') {
    setMemory(conversation, 'uncertainTurns', count);
    setMemory(conversation, 'uncertainTurnId', String(turnId));
    await conversation.save();
  }
  const needsReview = count >= 2;
  const question = !facts.serviceNeeded
    ? 'What needs repair or service? A short description of the problem will help.'
    : !facts.address
      ? 'I have the service details. What is the service address?'
      : !facts.preferredAppointmentTime
        ? 'I have the service and address. What day would you prefer? This is a preference only.'
        : 'I have your service details, address, and preferred time. What would you like to clarify or change?';
  return {
    ...result, ...facts, decision: 'send_fixed_response', actionType: needsReview ? 'human_handoff' : 'request_information',
    messageCategory: facts.serviceNeeded ? 'service_details' : 'unknown', urgency: lead?.urgency || 'medium',
    reply: needsReview ? 'A team member needs to review your request. You do not need to repeat the details already provided.' : question,
    intakeReady: false, estimatedValue: 0, leadQualityScore: lead?.leadQualityScore || 0,
    shouldAlertOwner: needsReview || Boolean(result.shouldAlertOwner),
    ...(needsReview ? { handoff: { required: true, reason: 'intake_unclear', callbackRequested: false } } : { handoff: undefined }),
    guardrail: { skipAI: true, usedFallback: false, reason: 'uncertain_model_reply' },
  };
};
