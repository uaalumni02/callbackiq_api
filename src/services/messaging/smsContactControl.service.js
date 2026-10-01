// Narrow customer-initiated control messages may be acknowledged during staff
// ownership. They never resume AI, change appointment state, or promise staff receipt.
import { isCallbackRequestText } from './customerContactIntent.service.js';

const clean = value => String(value || '').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const RECEIPT = [
  /^(?:any updates?|what is the status|what's the status)(?: on| of)? (?:my|the) (?:callback|call back|message|text|request)(?: request)?$/i,
  /^(?:can|could) you confirm (?:you |that you )?(?:got|received|saw) (?:my|the) (?:message|text|sms|request)$/i,
  /^(?:please[, ]+)?(?:did|have|has) (?:you|anyone|someone) (?:get|got|receive|received|see|seen) (?:my|the|that|this|our|your) (?:last |previous |earlier )?(?:text(?: message)?|message|sms|request|callback request|call back request)s?(?: yet)?$/i,
  /^(?:did|has) (?:my|the|our) (?:text|message|sms|request|callback request) (?:go through|come through|arrive|send|been sent|been received)$/i,
  /^(?:are you (?:still )?there|anyone there|did you get that)$/i,
  /^(?:when (?:will|can|is)|will|can|is) (?:someone|a person|the team|staff) (?:going to |able to )?(?:call|call back|contact|respond|reply)(?: me| to me)?$/i,
];
const CONTACT = /^(?:(?:please|can you|could you|would you|can someone|could someone)\s+)?(?:call me(?: back)?|give me a call(?: back)?|phone me|ring me|request (?:a )?callback|(?:have|ask) (?:the team|someone|a person|a human)(?: to)? call me(?: back)?|(?:i (?:want|need|would like) to )?(?:talk|speak)(?: to| with) (?:a |the )?(?:person|someone|human|representative|agent|manager|owner|staff member)|(?:a )?(?:human|representative|staff member))(?: please| on this number| at this number| when you get a chance| when available)?$/i;

export const isReceiptQuestion = value => {
  const text = clean(value).replace(/[.!?]+$/g, '').trim();
  return RECEIPT.some(pattern => pattern.test(text));
};

export function smsContactControlKind(value) {
  const clauses = String(value || '').split(/[.!?;\n]+/).map(s => clean(s)).filter(Boolean);
  if (!clauses.length) return '';
  const kinds = clauses.map(text => CONTACT.test(text) ? (isCallbackRequestText(text) ? 'callback' : 'human')
    : isReceiptQuestion(text) ? 'receipt' : '');
  if (kinds.some(kind => !kind)) return '';
  return kinds.includes('callback') ? 'callback' : kinds.includes('human') ? 'human' : 'receipt';
}

export const canAcknowledgeSmsContactControl = conversation =>
  Boolean(conversation && !['closed', 'archived'].includes(conversation.status) &&
    (conversation.aiEnabled !== false || conversation.humanTakeover === true));

export function contactControlReply({ kind, conversation, savedRequest = false }) {
  const recorded = conversation?.conversationMemory?.recoveryIntake?.contactControl?.request;
  const queue = savedRequest || Boolean(recorded?.alertId);
  const opening = kind === 'receipt'
    ? `Yes, your message was received.${queue ? ' Your request to speak with the team is saved for review.' : ''}`
    : kind === 'callback'
      ? "Your callback request is saved for the team at the number you're texting from."
      : 'Your request to speak with the team is saved for review.';
  return `${opening} A response time is not guaranteed. This message does not confirm or change an appointment.`;
}
