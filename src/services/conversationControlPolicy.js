const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
export const isRequestWithdrawal = value => {
  const text = clean(value);
  // Questions about consequences and conditional plans do not authorize deletion.
  if (/\b(?:if|unless|before|after|whether)\b.{0,60}\bcancel\b|\b(?:what happens|what would happen|do i (?:have|need) to|am i able to|is it possible to|tell me (?:how|about)|thinking (?:of|about)|might|may)\b.{0,60}\bcancel\b/i.test(text)) return false;
  if (/\b(?:don['’]t|do not|never|won['’]t|will not|can['’]t|cannot|not)\b.{0,35}\bcancel\b|\b(?:what if|how (?:do|can|would)|can i|could i|should i|cancellation (?:fee|policy))\b/i.test(text)) return false;
  return /\b(?:i|we) (?:don['’]?t|do not|no longer) (?:need|want) (?:your |the |this |that |any )?(?:service|help|appointment|visit|repair|work)\b/i.test(text) ||
    /^(?:please )?cancel(?: (?:it|that|this|my request|the request|my appointment|the appointment|my booking|the booking|the visit))?[.! ]*$/i.test(text) ||
    /\b(?:cancel|withdraw) (?:my |the |this |that )?(?:request|appointment|booking|visit)\b/i.test(text) ||
    /^(?:never mind|nevermind|no longer needed)[.! ]*$/i.test(text);
};

export const requestWasWithdrawn = conversation => {
  const state = conversation?.conversationMemory?.recoveryIntake;
  return Boolean(state?.withdrawnAt && state.journeyKey === (conversation?.orchestration?.recoveryJourneyKey || ''));
};
