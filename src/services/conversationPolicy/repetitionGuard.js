/** Read-only reply quality guard. Cannot change bookings, safety, delivery or handoff. */
import { evidenceSnapshot } from './dialogPolicy.js';
const sanitize = v => String(v || '').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g,' ').trim();
const sensitiveCategories = new Set(['emergency','hazardous_diy_request','stop','help','opt_out',
  'human_requested','booking_confirmation','appointment_confirmation','appointment_cancellation']);
const eligible = new Set(['appointment_status','human_handoff_status','appointment_preference']);
export function repetitionRisk(candidate, recentMessages = []) {
  const current = sanitize(candidate);
  if (current.length < 25) return false;
  const prev = [...recentMessages].reverse().find(m => ['outbound','assistant'].includes(m?.direction || m?.role));
  const previous = sanitize(prev?.body || prev?.text || prev?.content);
  if (previous.length < 25) return false;
  if (current === previous) return true;
  const set = new Set(current.split(' '));
  const prior = new Set(previous.split(' '));
  const common = [...set].filter(word => prior.has(word)).length;
  return common / Math.max(1, set.size + prior.size - common) >= 0.91;
}
export function preventNonProgressReply({ result, customerMessage, recentMessages = [], lead = {}, conversation = {}, mode = 'observe' } = {}) {
  if (!result || result.decision === 'no_reply' || sensitiveCategories.has(result.messageCategory) ||
      !eligible.has(result.messageCategory) || !repetitionRisk(result.reply, recentMessages) ||
      conversation.humanTakeover || conversation.aiEnabled === false) return { result, loopRisk: false, changed: false };
  const snapshot = evidenceSnapshot({ lead, conversation });
  if (snapshot.booked || snapshot.pendingOffer || snapshot.humanOwns || result.handoff?.required ||
      result.riskFlags?.length) return { result, loopRisk: true, changed: false };
  if (mode !== 'active') return { result, loopRisk: true, changed: false };
  const queue = snapshot.reviewQueued ? 'Your request is queued for staff review.' :
    "I have your details, but I can't verify that the staff-review task was queued.";
  const next = !snapshot.hasService ? 'What service do you need?' : !snapshot.hasAddress
    ? 'What is the service address?' : !snapshot.hasPreference ? 'What day would work best?' :
      'You can give me a backup day if your first choice does not work.';
  const reply = `${queue} I don't have a confirmed appointment or technician arrival time. ${next}`;
  return { result: { ...result, reply,
    guardrail: { ...(result.guardrail || {}), reason: 'dialog_v3_repetition_recovery' } },
    loopRisk: true, changed: true };
}
