import { handleExistingBookingTurn } from "./bookingExistingTurnRuntime.js";
import { findBookingConversation } from "./bookingConversation.repository.js";
import { createBookingTurnContext, isBookingTurnBlocked } from "./bookingTurnDecision.policy.js";
import { mergeBookingClassification } from "./bookingClassification.policy.js";
import { selectOfferedSlot } from "./offeredSlotSelection.service.js";
import { classifySmsIntent } from "../messaging/smsIntentClassifier.service.js";
import { resetExpiredBookingTurn } from "./bookingTurnState.repository.js";
import { routeBookingPreflight, checkBookingReadiness } from "./bookingTurnPreflight.service.js";
import { handleReadOnlyBookingTurn } from "./bookingReadOnlyTurn.service.js";
import { collectBookingService, collectBookingStreetAddress, collectBookingPostalCode } from "./bookingIntakeTurn.service.js";
import { collectBookingPreference, selectBookingOffer } from "./bookingAvailabilityTurn.service.js";
import { confirmBookingOffer } from "./bookingConfirmationTurn.service.js";

export { selectOfferedSlot };

const stateHandlers = new Map([
  ["not_started", collectBookingService],
  ["collecting_service", collectBookingService],
  ["collecting_street_address", collectBookingStreetAddress],
  ["collecting_location", collectBookingStreetAddress],
  ["collecting_postal_code", collectBookingPostalCode],
  ["collecting_preference", collectBookingPreference],
  ["offering_slots", selectBookingOffer],
  ["awaiting_confirmation", confirmBookingOffer],
  ["pending_business_confirmation", handleExistingBookingTurn],
  ["booked", handleExistingBookingTurn],
]);

async function dispatchBookingTurn(context) {
  const { activeConversation } = context;
  // A handler can consume facts and pass the same turn to the next state.
  // Each state runs at most once during that forward progression.
  const handledStates = new Set();
  let status = activeConversation.bookingState?.status || "not_started";
  while (stateHandlers.has(status) && !handledStates.has(status)) {
    handledStates.add(status);
    const result = await stateHandlers.get(status)({ ...context, status });
    if (result) return result;
    status = activeConversation.bookingState?.status || "not_started";
  }
  return { handled: false };
}

class BookingStateMachineService {
  static async findConversation({ business, lead, conversation }) {
    return findBookingConversation({ business, lead, conversation });
  }

  static async handle(parameters) {
    const classification = classifySmsIntent(parameters);
    const outcome = await this.handleTurn(parameters);
    return mergeBookingClassification({ parameters, classification, outcome });
  }

  static async handleTurn({
    business,
    lead,
    conversation,
    customerMessage,
    channel = "sms",
    source = "booking_state_machine",
  }) {
    const turn = createBookingTurnContext({ business, customerMessage, channel, source });
    if (isBookingTurnBlocked(conversation)) return { handled: false };
    const context = { business, lead, conversation, customerMessage, channel, ...turn };
    const preflight = await routeBookingPreflight(context);
    if (preflight) return preflight;
    if (!turn.enabled) return handleReadOnlyBookingTurn(context);

    const activeConversation = await this.findConversation({ business, lead, conversation });
    if (!activeConversation || activeConversation.humanTakeover) return { handled: false };
    const smsIntent = classifySmsIntent({ customerMessage: turn.text, business, conversation: activeConversation });
    const currentStatus = activeConversation.bookingState?.status || "not_started";
    const active = { ...context, activeConversation, smsIntent, currentStatus,
      handle: this.handle.bind(this), handleTurn: this.handleTurn.bind(this) };
    const readinessReply = await checkBookingReadiness(active);
    if (readinessReply) return readinessReply;
    const expiredReply = await resetExpiredBookingTurn(active);
    if (expiredReply) return expiredReply;
    return dispatchBookingTurn(active);
  }
}

export default BookingStateMachineService;
