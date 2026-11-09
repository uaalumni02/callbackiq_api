import { fixedResult } from "./bookingFixedResult.policy.js";
import { applyBookingStateFields } from "./requestBookingState.js";
import { assertVoiceTurnActive } from "../voiceTurnContext.service.js";
import { assertDistributedLeaseActive } from "../distributedLease.service.js";

export const updateState = async (conversation, changes) => {
  assertVoiceTurnActive();
  assertDistributedLeaseActive();
  applyBookingStateFields(conversation, changes);
  await conversation.save();
  assertVoiceTurnActive();
  assertDistributedLeaseActive();
};

export async function resetExpiredBookingTurn({ activeConversation, text, currentStatus }) {
  const offerExpired = Boolean(
    activeConversation.bookingState?.status !== 'pending_business_confirmation' && activeConversation.bookingState?.expiresAt &&
      activeConversation.bookingState.expiresAt < new Date(),
  );

  if (currentStatus === "failed" || offerExpired) {
    await updateState(activeConversation, {
      status: "collecting_service",
      offeredSlots: [],
      selectedSlot: null,
      negotiationAttempts: 0,
      lastCustomerPreference: text,
      lastAvailabilityCheckedAt: new Date(),
      expiresAt: null,
      lastError: "",
    });

    // The customer's reply belongs to the stale offer. Return after the
    // reset so words such as "first" are not treated as a new service.
    if (offerExpired) {
      return {
        handled: true,
        result: fixedResult({
          reply:
            "That appointment offer expired. What service would you like to schedule?",
        }),
      };
    }
  }
}
