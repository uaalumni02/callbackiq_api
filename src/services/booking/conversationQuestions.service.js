// Shared, read-only conversational answers. Never submits or confirms a booking.
export const isConfirmationQuestion = (text) =>
  /\b(?:will|can|does|do|how|when|who|is|has)\b.*\b(?:confirm|confirmation|confirmed|approve|approved|approval|accept|accepted|acceptance)\b/i.test(String(text || "")) ||
  /\b(?:is|was) (?:it|that|this|my appointment) booked\b/i.test(String(text || ""));

export const isAmbiguousServiceLoss = (text) =>
  /^(?:a |there is a |it is a |it's a )?loss of service[.! ]*$/i.test(String(text || "").trim());

export const serviceLossQuestion = "Is only this fixture unusable, or is the whole property affected? Is anything actively leaking or overflowing?";

export const bookingQuestionReply = ({ customerMessage, conversation }) => {
  if (!isConfirmationQuestion(customerMessage)) return null;
  if (/\b(?:call me|speak to|talk to|human|representative|cancel|reschedule)\b/i.test(customerMessage)) return null;
  const state = conversation?.bookingState || {};
  if (state.status === "human_takeover" && state.lastError === "selected_slot_requires_manual_confirmation") {
    return "Your preferred time has been sent to the team for review. It is not a confirmed appointment. I don't have a confirmation timeframe and can't guarantee a confirmation call. Please wait for the team to confirm before expecting a visit.";
  }
  if (state.status === "offering_slots") {
    return "These are available options only; no appointment has been submitted or reserved. Choose a time first. The team must approve the request before it is confirmed.";
  }
  if (state.status === "awaiting_confirmation") {
    return "Your selected time has not been submitted yet. Say yes to submit it for business approval, or no to choose another time. I can't guarantee a confirmation call.";
  }
  return null; // Appointment-backed states must be checked against the database.
};
