import { bookingStateFields } from '../../../services/booking/requestBookingState.js';
import Conversation from "../../../models/conversation.js";
import ConversionEventService from "../../../services/conversionEvent.service.js";
import InterventionService from "../../../services/intervention.service.js";

export const escalateToHumanTool = async ({
  businessId,
  leadId,
  conversationId,
  reason,
  customerMessage = "",
}) => {
  await Conversation.updateOne(
    { _id: conversationId, business: businessId },
    {
      $set: {
        humanTakeover: true,
        aiEnabled: false,
        ...bookingStateFields({ status: "human_takeover",
        lastError: reason }),
      },
    },
  );
  await ConversionEventService.record({
    businessId,
    leadId,
    conversationId,
    type: "human_takeover",
    channel: "sms",
    source: "booking_state_machine",
    idempotencyKey: `human_takeover:${conversationId}:${reason}`,
    metadata: { reason },
  });
  return InterventionService.create({
    businessId,
    leadId,
    conversationId,
    type: "human_requested",
    title: "Customer needs a person",
    message: "The booking conversation was handed to staff.",
    priority: "high",
    reason,
    recommendedAction: "Open the conversation and respond directly.",
    lastCustomerMessage: customerMessage,
    dedupeKey: `human_requested:${conversationId}:${reason}`,
  });
};

export default escalateToHumanTool;
