import { fixedResult } from "./bookingFixedResult.policy.js";
import { applyBookingStateFields } from "./requestBookingState.js";
import { assertVoiceTurnActive } from "../voiceTurnContext.service.js";
import { assertDistributedLeaseActive, getDistributedLeaseWriteDeadline } from "../distributedLease.service.js";

export const updateState = async (conversation, changes) => {
  assertVoiceTurnActive();
  assertDistributedLeaseActive();
  applyBookingStateFields(conversation, changes);
  await conversation.save();
  assertVoiceTurnActive();
  assertDistributedLeaseActive();
};

const bookingEvents = new Map([
  ['select_offer', {
    from: 'offering_slots',
    to: 'awaiting_confirmation',
    writes: ({ selectedSlot, expiresAt }) => ({ selectedSlot, expiresAt }),
    guard: ({ selectedSlot }) => ({
      'bookingState.offeredSlots': { $elemMatch: { startAt: selectedSlot.startAt, endAt: selectedSlot.endAt } },
    }),
  }],
  ['request_new_offer', {
    from: 'offering_slots',
    to: 'collecting_preference',
  }],
  ['claim_confirmation', {
    from: 'awaiting_confirmation',
    to: 'booking',
    intent: (state) => ({ type: 'submit_appointment', selectedSlot: state.selectedSlot }),
  }],
  ['decline_confirmation', {
    from: 'awaiting_confirmation',
    to: 'collecting_preference',
    writes: () => ({ selectedSlot: null, offeredSlots: [], expiresAt: null }),
  }],
]);

function bookingDecisionFilter(conversation, transition, context) {
  const state = conversation.bookingState;
  const leaseDeadline = getDistributedLeaseWriteDeadline();
  const expiryGuards = [
    { $gte: [{ $ifNull: ['$bookingState.expiresAt', '$$NOW'] }, '$$NOW'] },
  ];
  if (leaseDeadline) expiryGuards.push({ $lt: ['$$NOW', leaseDeadline] });
  return {
    business: context.businessId,
    status: { $nin: ['closed', 'archived'] },
    humanTakeover: { $ne: true },
    'bookingState.status': transition.from,
    'bookingState.expiresAt': state.expiresAt ?? null,
    'bookingState.appointment': state.appointment?._id ?? state.appointment ?? null,
    'bookingState.selectedSlot.startAt': state.selectedSlot?.startAt ?? null,
    'bookingState.selectedSlot.endAt': state.selectedSlot?.endAt ?? null,
    $expr: { $and: expiryGuards },
    ...transition.guard?.(context),
  };
}

function bookingStateConflict() {
  return Object.assign(new Error('The booking state changed before the booking decision.'), { code: 'BOOKING_STATE_CONFLICT' });
}

export async function applyBookingEvent(conversation, event, context) {
  const transition = bookingEvents.get(event);
  if (!transition) throw new TypeError(`Unknown booking event: ${event}`);
  if (conversation.bookingState?.status !== transition.from) throw bookingStateConflict();

  // A caller can act on the selected offer only after this conditional write succeeds.
  // Preserve the document's existing session, validators and dirty paths.
  const priorWhere = conversation.$where;
  const filter = bookingDecisionFilter(conversation, transition, context);
  const intent = transition.intent?.(conversation.bookingState) ?? null;
  conversation.$where = priorWhere ? { $and: [priorWhere, filter] } : filter;
  try {
    await updateState(conversation, { ...transition.writes?.(context), status: transition.to });
  } catch (error) {
    if (!['DocumentNotFoundError', 'VersionError'].includes(error?.name)) throw error;
    assertDistributedLeaseActive();
    throw bookingStateConflict();
  } finally {
    conversation.$where = priorWhere;
  }
  return intent;
}

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
