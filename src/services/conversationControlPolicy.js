const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
export const isRequestWithdrawal = value => {
  const text = clean(value);
  if (/\b(?:don't|don’t|do not|never)\s+cancel\b|\b(?:what if|how (?:do|can)|cancellation (?:fee|policy))\b/i.test(text)) return false;
  return /\b(?:i|we) (?:don['’]?t|do not|no longer) (?:need|want) (?:your |the |this |that |any )?(?:service|help|appointment|visit|repair|work)\b/i.test(text) ||
    /^(?:please )?cancel(?: (?:it|that|this|my request|the request|my appointment|the appointment|my booking|the booking|the visit))?[.! ]*$/i.test(text) ||
    /\b(?:cancel|withdraw) (?:my |the |this |that )?(?:request|appointment|booking|visit)\b/i.test(text) ||
    /^(?:never mind|nevermind|no longer needed)[.! ]*$/i.test(text);
};

export const requestWasWithdrawn = conversation => {
  const state = conversation?.conversationMemory?.recoveryIntake;
  return Boolean(state?.withdrawnAt && state.journeyKey === (conversation?.orchestration?.recoveryJourneyKey || ''));
};
