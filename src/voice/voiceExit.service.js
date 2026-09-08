import { optOutSms } from '../services/messaging/contactPreference.service.js';
import { assertVoiceTurnActive } from '../services/voiceTurnContext.service.js';

export const handleVoiceExit = async ({ session, customerMessage }) => {
  const text = String(customerMessage || '').replace(/[’‘]/g, "'").trim();
  const optOut = /\b(?:do not|don't|stop) (?:call(?:ing)?|text(?:ing)?|contact(?:ing)?)(?: me| us)?\b|\bremove my number\b/i.test(text);
  const wrong = /\bwrong number\b/i.test(text);
  const end = /^(?:please )?(?:stop|end (?:this|the) call|hang up|goodbye)[.! ]*$/i.test(text);
  if (!optOut && !wrong && !end) return null;
  assertVoiceTurnActive();
  const phone = session.from || session.lead?.phone || session.conversation?.customerPhone;
  if ((optOut || wrong) && phone) {
    await optOutSms({ businessId: session.business._id, phone, source: 'customer_request', keyword: text });
    assertVoiceTurnActive();
  }
  if (optOut || wrong) {
    session.conversation.aiEnabled = false;
    await session.conversation.save();
    assertVoiceTurnActive();
    if (session.lead?.save) {
      session.lead.notes = `${session.lead.notes || ''}\nVoice caller requested no further contact: ${text}`.slice(-2000);
      await session.lead.save(); assertVoiceTurnActive();
    }
  }
  const outcome = optOut ? 'opted_out' : wrong ? 'wrong_number' : 'caller_declined';
  session.outcome = outcome;
  session.outcomeCommittedAt = new Date();
  session.status = 'completing';
  await session.save(); assertVoiceTurnActive();
  return { reply: "Understood. I'll end this call now.", outcome, handoff: { type: 'end', handoffData: JSON.stringify({ reasonCode: outcome }) } };
};
