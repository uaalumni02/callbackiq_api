const clean = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();
const requestWithdrawal = (value) => {
  const text = clean(value)
    .replace(/[‘’]/g, "'")
    .replace(/^(?:actually|okay|ok)[, ]+/i, "")
    .replace(/^never mind[,.! ]+(?=cancel\b)/i, "");
  // A mention of cancellation is not permission. Keep/reversal language wins
  // over an earlier instruction in the same message. Ambiguity preserves the visit.
  if (
    /\b(?:keep|retain) (?:it|(?:my|the|this|our) (?:appointment|booking|visit|request))\b|\bleave (?:it|(?:my|the|this|our) (?:appointment|booking|visit|request)) (?:as is|unchanged|alone)\b|\bchanged (?:my|our) mind\b/i.test(
      text,
    )
  )
    return false;
  if (
    /\b(?:didn't|did not|don't|do not|never|not)\b.{0,120}\b(?:cancel|withdraw)\b/i.test(
      text,
    )
  )
    return false;
  if (/\b(?:cancel|withdraw)\b.*\b(?:if|unless|whether)\b/i.test(text))
    return false;
  // Questions about consequences and conditional plans do not authorize deletion.
  if (
    /\b(?:if|unless|before|after|whether)\b.{0,60}\bcancel\b|\b(?:what happens|what would happen|do i (?:have|need) to|am i able to|is it possible to|tell me (?:how|about)|thinking (?:of|about)|might|may)\b.{0,60}\bcancel\b/i.test(
      text,
    )
  )
    return false;
  if (
    /\b(?:don['’]t|do not|never|won['’]t|will not|can['’]t|cannot|not)\b.{0,35}\bcancel\b|\b(?:what if|how (?:do|can|would)|can i|could i|should i|cancellation (?:fee|policy))\b/i.test(
      text,
    )
  )
    return false;
  if (
    /^(?:please )?(?:don't|do not) come(?: at all)?[.! ]*$/i.test(text) ||
    /^no longer need (?:the |your |this )?(?:service|appointment|visit)[.! ]*$/i.test(
      text,
    )
  )
    return true;
  return (
    /\b(?:i|we) (?:don['’]?t|do not|no longer) (?:need|want) (?:your |the |this |that |any )?(?:service|help|appointment|visit|repair|work)\b/i.test(
      text,
    ) ||
    /^(?:please )?cancel(?: (?:it|that|this|my request|the request|my appointment|the appointment|my booking|the booking|the visit))?[.! ]*$/i.test(
      text,
    ) ||
    // Require a direct instruction, not quoted/reported or historical speech.
    /^(?:(?:hi|hello|actually|okay|ok|yes)[, ]+)?(?:please )?(?:(?:i|we) (?:want|need|would like) (?:you )?to |(?:can|could|would) you (?:please )?)?(?:cancel|withdraw) (?:my |our |the |this |that )?(?:request|appointment|booking|visit)(?:,? (?:please|thanks|thank you|now))?[.!]*(?:$|\s+(?:call me|please call me)\b)/i.test(
      text,
    ) ||
    /^(?:never mind|nevermind|no longer needed)[.! ]*$/i.test(text)
  );
};

/** Decides withdrawal without treating negation, descriptions, questions or STOP consent as appointment cancellation. */
export function assessWithdrawalIntent(value) {
  const text = clean(value).replace(/[‘’]/g, "'");
  const request = requestWithdrawal(text);
  const callbackOnly =
    /^(?:please )?(?:stop(?: this)?|forget it|do not submit|don't submit|no callback|leave it alone)[.! ]*$/i.test(
      text,
    );
  return {
    requestWithdrawal: request,
    callbackWithdrawal: request || callbackOnly,
    contactOptOut: /^stop(?:all)?[.! ]*$/i.test(text),
  };
}
/** Authorizes request withdrawal only for an explicit unambiguous instruction. */
export const isRequestWithdrawal = (value) =>
  assessWithdrawalIntent(value).requestWithdrawal;
