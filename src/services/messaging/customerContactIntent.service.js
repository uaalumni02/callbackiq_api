const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const CALLBACK_FORWARD_PATTERNS = [
  /\b(?:please\s+)?call me(?: back)?\b/i,
  /\bgive me a call(?: back)?\b/i,
  /\bcan you call(?: me)?\b/i,
  /\bhave (?:the team|someone|a person|a human) call(?: me)?\b/i,
  /\bask (?:the )?team to call me\b/i,
  /\brequest (?:a )?callback\b/i,
  /\b(?:phone|ring) me\b/i,
];

const CALLBACK_PAST_PATTERNS = [
  /\b(?:i|we)\s+(?:called|call)\s+back\b/i,
  /\breturning (?:your|a) call\b/i,
];

const CALLBACK_DECLINED_PATTERNS = [
  /\b(?:don['’]?t|do not|never|stop|no need to|please don['’]?t|please do not)\b.{0,24}\b(?:call(?:ing)?|callback|phone|ring)(?:\s+me)?\b/i,
  /\bi\s+(?:don['’]?t|do not)\s+want\s+(?:a\s+)?(?:call|callback|phone call)\b/i,
  /\bno\s+(?:call|callback|phone call)\b/i,
  /\btext\s+me\s+instead\b/i,
];

export const isCallbackDeclinedText = (value) => {
  const text = clean(value);
  return Boolean(text && CALLBACK_DECLINED_PATTERNS.some((pattern) => pattern.test(text)));
};

export const isCallbackRequestText = (value) => {
  const text = clean(value);
  if (!text || isCallbackDeclinedText(text)) return false;
  if (CALLBACK_PAST_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return CALLBACK_FORWARD_PATTERNS.some((pattern) => pattern.test(text));
};

export const customerContactPreference = (value) => {
  const text = clean(value);
  const callbackDeclined = isCallbackDeclinedText(text);
  const callbackRequested = !callbackDeclined && isCallbackRequestText(text);
  return {
    callbackRequested,
    callbackDeclined,
    preferredChannel: /\btext\s+me\s+instead\b/i.test(text) ? 'sms' : '',
  };
};

export default {
  customerContactPreference,
  isCallbackDeclinedText,
  isCallbackRequestText,
};
