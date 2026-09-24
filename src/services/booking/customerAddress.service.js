// Capture customer evidence. This does not validate deliverability or authorize service.
const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const suffix = /\b(?:st(?:reet)?|ave(?:nue)?|rd|road|dr(?:ive)?|ln|lane|ct|court|blvd|boulevard|way|pkwy|parkway|place|pl|circle|cir|trail|trl|terrace|ter|highway|hwy)\b/i;
const digits = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const numbers = { ...digits, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const numberWords = words => {
  if (words.every(word => Object.hasOwn(digits, word))) return words.map(word => digits[word]).join('');
  if (words.length === 2 && numbers[words[0]] < 10 && numbers[words[1]] >= 20) return String(numbers[words[0]] * 100 + numbers[words[1]]);
  let total = 0, group = 0;
  for (const word of words) {
    if (word === 'and') continue;
    if (word === 'hundred') { if (!group) return ''; group *= 100; }
    else if (word === 'thousand') { if (!group) return ''; total += group * 1000; group = 0; }
    else if (Object.hasOwn(numbers, word)) group += numbers[word];
    else return '';
  }
  return String(total + group);
};
export const normalizeSpokenAddress = value => {
  let text = clean(value);
  // ASR can split a house number or postal code into digit groups. Never
  // collapse arbitrary phone-length runs into a location.
  text = text.replace(/^(\d+(?: +\d+)+)(?= +[a-z])/i, (run) => {
    const joined = run.replace(/ /g, '');
    return joined.length <= 7 ? joined : run;
  });
  text = text.replace(/\b\d+(?: +\d+)+\b/g, run => {
    const joined = run.replace(/ /g, '');
    return joined.length === 5 ? joined : run;
  });
  text = text.replace(/\b(?:zip(?: code)?|postal code)\s*(?:is\s*)?((?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[ -]+){4}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine))\b/gi,
    (_, words) => words.toLowerCase().split(/[ -]+/).map(word => digits[word]).join(''));
  const postalDigits = text.toLowerCase().replace(/[.!]$/, '').split(/[ -]+/);
  if (postalDigits.length === 5 && postalDigits.every(word => Object.hasOwn(digits, word))) return postalDigits.map(word => digits[word]).join('');
  const tokens = text.split(' '); let count = 0;
  while (count < tokens.length && (Object.hasOwn(numbers, tokens[count].toLowerCase()) || ['hundred', 'thousand', 'and'].includes(tokens[count].toLowerCase()))) count++;
  if (count && count < tokens.length) {
    const number = numberWords(tokens.slice(0, count).map(word => word.toLowerCase()));
    if (number && number !== '0') text = `${number} ${tokens.slice(count).join(' ')}`;
  }
  return text;
};
export const isRepeatCorrection = value => /\b(?:just told you|already (?:told|said|gave|sent|provided)|you already have)\b/i.test(clean(value));
const parseAddressCandidate = (value, { expected = false } = {}) => {
  let text = clean(value).replace(/^(?:(?:actually|correction)[,:]?\s*)?(?:(?:my |the )?address is|i am at|i'm at|we are at|we're at|it is|it's|at)\s+/i, '');
  text = normalizeSpokenAddress(text);
  // Separate a supplied date/time from the location, without inventing street components.
  text = text.replace(/([\s\S]*?\b\d{5}(?:-\d{4})?)(?:[,;.]?\s+)(?=(?:on\s+)?(?:today|tomorrow|next|mon|tue|wed|thu|fri|sat|sun|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|at\s+\d|20\d{2}-))/i, '$1\n').split('\n')[0];
  // Match a postal token after the street number/name, then consume only a
  // bounded unit suffix. Do not let regex backtracking discard ZIP+4 or units.
  const postalEnd = /^(\d{1,7}[a-z]?(?:-\d+)?\s+[a-z][\s\S]*?\s\d{5}(?:-\d{4})?)\b/i.exec(text);
  if (postalEnd) {
    const tail = text.slice(postalEnd[0].length);
    const unit = /^\s*,?\s*(?:(?:apt|apartment|unit|suite|ste|bldg|building|lot)\.?\s*#?\s*|#\s*)([a-z0-9]+(?:-[a-z0-9]+)?)(?=$|[\s.,;!?])/i.exec(tail);
    text = postalEnd[0] + (unit ? ` ${unit[0].trim().replace(/^,\s*/, '')}` : '');
  }
  if (!/^\d{1,7}[a-z]?(?:-\d+)?\s+[a-z]/i.test(text) || text.length > 500) return '';
  if (/\b(?:dollars?|bucks?|minutes?|hours?|days?|weeks?|am|pm|percent|bedrooms?|bathrooms?)\b|\$|https?:|@/i.test(text)) return '';
  if (/\b(?:schedule|appointment|tomorrow|today|next week|please|need|want|repair|replace|cost|quote)\b/i.test(text)) return '';
  const zip = /\b\d{5}(?:-\d{4})?\b/.test(text);
  const words = text.split(/\s+/).length;
  return suffix.test(text) || (zip && words >= 3) || (expected && words >= 3) ? text : '';
};
export const isAddressOnlyTurn = value => Boolean(parseAddressCandidate(value, { expected: true }));
// A turn can contain service, location, and timing together. Parse customer text
// at clause/location boundaries; do not require the address to occupy the turn.
export const extractCustomerAddress = (value, options = {}) => {
  const text = clean(value);
  const direct = parseAddressCandidate(text, options);
  if (direct) return direct;
  const candidates = [];
  const boundaries = /(?:[,;.!?]\s*|\b(?:address is|located at|i am at|i'm at|we are at|we're at|at)\s+)(?=\d{1,7}[a-z]?(?:-\d+)?(?:\s+\d+)*\s+[a-z])/gi;
  for (const match of text.matchAll(boundaries)) {
    const candidate = parseAddressCandidate(text.slice(match.index + match[0].length), options);
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  }
  // Multiple competing locations require clarification, never an arbitrary pick.
  return candidates.length === 1 ? candidates[0] : '';
};
// A five-digit street number is not a ZIP. Use the bounded address when
// available, and skip its leading street-number token before reading postal data.
const postalMatch = value => {
  const text = clean(value);
  const numberEnd = /^\d{1,7}[a-z]?(?:-\d+)?\s+[a-z]/i.test(text) ? text.indexOf(' ') : -1;
  return [...text.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].find(match => match.index > numberEnd) || null;
};
export const extractCustomerPostalCode = value => {
  const normalized = normalizeSpokenAddress(value);
  return postalMatch(extractCustomerAddress(normalized) || normalized)?.[1] || '';
};
export const withoutCustomerPostalCode = value => {
  const text = clean(value);
  const match = postalMatch(text);
  return match ? clean(text.slice(0, match.index) + text.slice(match.index + match[0].length)) : text;
};
export const addressFromTurn = ({ customerMessage, recentMessages = [], conversation = null, knownAddress = '' } = {}) => {
  const field = conversation?.conversationMemory?.recoveryIntake?.field;
  const expected = field === 'address' || ['collecting_location', 'collecting_street_address'].includes(conversation?.bookingState?.status);
  const zip = normalizeSpokenAddress(customerMessage).match(/^(?:(?:no|actually|correction)[, ]+)?(?:(?:the |my )?(?:zip(?: code)?|postal code)(?: is)?[: ]+)?(\d{5}(?:-\d{4})?)[.! ]*$/i)?.[1];
  if (zip && knownAddress && (!extractCustomerPostalCode(knownAddress) || /^(?:no|actually|correction|(?:the |my )?(?:zip|postal))\b/i.test(clean(customerMessage)))) {
    const match = postalMatch(knownAddress);
    return match ? knownAddress.slice(0, match.index) + zip + knownAddress.slice(match.index + match[0].length) : `${knownAddress}, ${zip}`;
  }
  if (isRepeatCorrection(customerMessage) && knownAddress) return knownAddress;
  const current = extractCustomerAddress(customerMessage, { expected });
  if (current || !isRepeatCorrection(customerMessage)) return current;
  const start = conversation?.orchestration?.recoveryJourneyStartedAt;
  for (const message of recentMessages.slice(-8).reverse()) {
    if (message.direction !== 'inbound' && message.role !== 'customer') continue;
    if (start && (!message.createdAt || new Date(message.createdAt) < new Date(start))) continue;
    const address = extractCustomerAddress(message.body || message.text, { expected: true });
    if (address) return address;
  }
  return '';
};


// The lead is the current request projection. Repair the older split storage
// only when the saved street agrees; never attach an old ZIP to a new address.
export const resolveRequestAddress = ({ customerMessage = '', lead = {}, conversation = {} } = {}) => {
  const booking = conversation.bookingState || {};
  const savedStreet = extractCustomerAddress(booking.streetAddress || '', { expected: true });
  let knownAddress = extractCustomerAddress(lead.address || '', { expected: true }) || savedStreet;
  const sameStreet = (a,b) => withoutCustomerPostalCode(a).replace(/[^a-z0-9]/gi,'').toLowerCase() === withoutCustomerPostalCode(b).replace(/[^a-z0-9]/gi,'').toLowerCase();
  if (knownAddress && !extractCustomerPostalCode(knownAddress) && savedStreet && sameStreet(knownAddress,savedStreet) && /^\d{5}(?:-\d{4})?$/.test(booking.postalCode || '')) {
    knownAddress = `${knownAddress}, ${booking.postalCode}`;
  }
  let incoming = addressFromTurn({ customerMessage, conversation, knownAddress });
  // A ZIP supplied before the first street belongs to this same collection step.
  if (incoming && !knownAddress && !extractCustomerPostalCode(incoming) &&
      ['collecting_location', 'collecting_street_address'].includes(booking.status) && /^\d{5}(?:-\d{4})?$/.test(booking.postalCode || '')) incoming = `${incoming}, ${booking.postalCode}`;
  return incoming || knownAddress;
};
