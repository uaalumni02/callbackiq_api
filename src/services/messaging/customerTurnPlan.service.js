import { classifySmsIntent, extractService } from './smsIntentClassifier.service.js';
import { isRequestWithdrawal } from '../conversationControlPolicy.js';
import { meaningfulServicePhrase } from '../serviceEligibility/policy.js';
import { normalizeServiceText } from '../catalog/servicePhrase.service.js';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
export function additionalServiceText(text, lead, conversation = null) {
  if (!clean(lead?.serviceNeeded) || /^unknown$/i.test(clean(lead.serviceNeeded))) return '';
  if (/\b(?:instead|rather than|replace (?:my|the) request)\b/i.test(text) || isRequestWithdrawal(text)) return '';
  // A follow-up explicitly naming recorded additional work stays attached to
  // that work. Mentioning it again is not permission to replace the primary job.
  const words = new Set(normalizeServiceText(text).split(' '));
  const primaryWords = new Set(normalizeServiceText(lead.serviceNeeded).split(' '));
  const previous = conversation?.conversationMemory?.recoveryIntake?.additionalRequests || [];
  const referenced = previous.filter(item => normalizeServiceText(item.request).split(' ')
    .some(word => meaningfulServicePhrase(word) && !primaryWords.has(word) && words.has(word)));
  if (referenced.length === 1) return referenced[0].request;
  // "The faucet also leaks" adds a symptom to the current request. Require
  // an explicit additional-request construction before separating work.
  if (!/(?:\b(?:one more (?:thing|issue)|in addition|another (?:issue|problem)|while you['’]re here|too|as well)|\b(?:can|could|do|would) you also\b|\b(?:i|we) also (?:need|want|have)\b|\band also\b|^\s*also\b)/i.test(text)) return '';
  const marker = /\b(?:also|in addition|another (?:issue|problem)|one more (?:thing|issue)|while you['’]re here|too|as well)\b/i;
  if (!marker.test(text)) return '';
  const clauses = clean(text).split(/[.!?;]+|\b(?:and )?i still (?:need|want)\b/i);
  const clause = clauses.find(part => marker.test(part)) || '';
  const request = (/\b(?:too|as well)\s*$/i.test(clause) ? clause.replace(/\b(?:too|as well)\s*$/i, '') : clause.replace(/^.*?\b(?:also|in addition|another (?:issue|problem)|one more (?:thing|issue)|while you['’]re here)\b[:, ]*/i, ''))
    .replace(/^(?:can|could|would|do) you\s+(?:also\s+)?/i, '')
    .replace(/\s+or (?:do|should|would|will) (?:i|we)\b.*$/i, '').trim();
  const extracted = extractService(request);
  const intents = classifySmsIntent({ customerMessage: request }).intents;
  if (!extracted && ['human', 'callback', 'status', 'pricing', 'scheduling', 'cancel', 'reschedule'].some(key => intents[key])) return '';
  return clean(extracted || request).slice(0, 200);
}

export function planCustomerTurn({ customerMessage, business, lead, conversation }) {
  const text = clean(customerMessage);
  const classified = classifySmsIntent({ customerMessage: text, business, lead, conversation });
  const withdrawal = isRequestWithdrawal(text) || classified.intents.cancel;
  const callback = classified.intents.human || classified.intents.callback;
  const confirmation = /\b(?:guarantee|guaranteed|confirmed|confirmation|approve|approved|booked|reserved)\b/i.test(text);
  const additionalRequest = withdrawal ? '' : additionalServiceText(text, lead, conversation);
  const selectionReference = /\b(?:option\s*\d+|first option|second option|third option|that time|this time)\b/i.test(text);
  const selectionContext = ['offering_slots', 'awaiting_confirmation'].includes(conversation?.bookingState?.status);
  return { text, classified, withdrawal, callback, confirmation, additionalRequest,
    compound: !withdrawal && callback &&
      (selectionContext || selectionReference || confirmation || classified.intents.pricing || classified.intents.availabilityInquiry || classified.intents.reschedule) };
}
