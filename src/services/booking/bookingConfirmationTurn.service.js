import { fixedResult } from './bookingFixedResult.policy.js';
import { submitRescheduleRequest } from '../scheduling/rescheduleRequest.service.js';
import { renderAppointmentResponse } from '../scheduling/customerAppointmentPresentation.service.js';
import { assertVoiceTurnActive } from "../voiceTurnContext.service.js";
import createAppointmentTool from "../../helpers/ai/tools/createAppointment.tool.js";
import { updateState } from "./bookingTurnState.repository.js";
import { bookingInquiryOperations } from "./bookingInquiryRuntime.js";
const { formatSlot } = bookingInquiryOperations;

export async function confirmBookingOffer(context) {
  const { business, lead, activeConversation, smsIntent, bookingChannel, bookingIdempotencyPrefix } = context;
  if (smsIntent.response.negative) {
    await updateState(activeConversation, {
      status: "collecting_preference",
      selectedSlot: null,
      offeredSlots: [],
      expiresAt: null,
    });

    return {
      handled: true,
      result: fixedResult({
        reply: "No problem. What other day would you prefer?",
      }),
    };
  }

  if (!smsIntent.response.affirmative) {
    return {
      handled: true,
      result: fixedResult({
        reply:
          "Please reply CONFIRM to submit that exact time for business approval, or NO to choose another day.",
      }),
    };
  }

  const selectedSlot = activeConversation.bookingState.selectedSlot;
  assertVoiceTurnActive();
  await updateState(activeConversation, { status: "booking" });

  try {
    const bookingInput = buildBookingInput({ business, lead, activeConversation, selectedSlot, bookingChannel });
    const isReschedule =
      activeConversation.bookingState.lastError ===
        "reschedule_requested" &&
      activeConversation.bookingState.appointment;
    assertVoiceTurnActive();
    if (isReschedule) {
      return await submitBookingReschedule(context, selectedSlot);
    }

    const appointment = await createAppointmentTool({
      business,
      idempotencyKey: `${bookingIdempotencyPrefix}ai-book:${activeConversation._id}:${new Date(
        selectedSlot.startAt,
      ).toISOString()}`,
      input: bookingInput,
    });

    assertVoiceTurnActive();
    if (
      !(appointment.status === 'confirmed' && appointment.automaticConfirmationAuthorized === true) &&
      (appointment.status !== "held" || appointment.requiresBusinessApproval !== true)
    ) {
      const invariantError = new Error(
        "AI appointment creation bypassed the required business-approval hold.",
      );
      invariantError.code = "AI_BOOKING_APPROVAL_INVARIANT_VIOLATION";
      invariantError.safeCustomerMessage =
        "I couldn’t safely submit that appointment request. I’ve alerted the team so they can confirm a time directly.";
      throw invariantError;
    }

    if (appointment.status === 'confirmed' && appointment.automaticConfirmationAuthorized === true) {
      await updateState(activeConversation, { status: 'booked', appointment: appointment._id, expiresAt: null, lastError: '' });
      return { handled: true, result: fixedResult({ reply: renderAppointmentResponse({ kind: 'confirmed', label: formatSlot(appointment, appointment.timezone) }, bookingChannel) }) };
    }
    await updateState(activeConversation, {
      status: "pending_business_confirmation",
      appointment: appointment._id,
      expiresAt: appointment.heldExpiresAt || null,
      lastError: "",
    });

    return {
      handled: true,
      result: fixedResult({
        reply: renderAppointmentResponse({ kind: 'submitted', label: formatSlot(appointment, appointment.timezone) }, bookingChannel),
      }),
    };
  } catch (error) {
    await updateState(activeConversation, {
      status: "failed",
      lastError: error.message,
      expiresAt: null,
    });

    return {
      handled: true,
      result: fixedResult({
        reply:
          error.safeCustomerMessage ||
          "I’m having trouble confirming that appointment right now. I’ve sent your request to the team so they can confirm it directly.",
      }),
    };
  }
}

function buildBookingInput({ business, lead, activeConversation, selectedSlot, bookingChannel }) {
  return {
    lead: lead?._id,
    conversation: activeConversation._id,
    serviceOfferingId:
      activeConversation.bookingState.serviceOffering,
    customerName:
      lead?.customerName || activeConversation.customerName,
    customerPhone:
      lead?.phone || activeConversation.customerPhone,
    customerEmail: lead?.email || "",
    address: {
      street:
        activeConversation.bookingState.streetAddress ||
        lead?.address ||
        "",
      postalCode: activeConversation.bookingState.postalCode,
    },
    startAt: selectedSlot.startAt,
    endAt: selectedSlot.endAt,
    timezone: business.timezone || "America/New_York",
    estimatedValue: lead?.estimatedValue ?? null,
    source: bookingChannel,
    bookedBy: "ai",
    urgency: lead?.urgency || "medium",
  };
}

async function submitBookingReschedule({ business, activeConversation, bookingChannel }, selectedSlot) {
  const requestedTime = formatSlot(
    selectedSlot,
    business.timezone || "America/New_York",
  );
  try {
    await submitRescheduleRequest({ business, appointmentId: activeConversation.bookingState.appointment,
      conversationId: activeConversation._id, startAt: selectedSlot.startAt, endAt: selectedSlot.endAt,
      channel: bookingChannel });
  } catch (error) {
    if (['VOICE_STALE_TURN', 'DISTRIBUTED_LEASE_LOST'].includes(error?.code)) throw error;
    return { handled: true, result: fixedResult({ reply: 'I could not verify that your change request reached the team. Your existing appointment has not been changed. Please contact the business directly or try again.' }) };
  }

  await updateState(activeConversation, {
    status: "booked",
    selectedSlot: null,
    offeredSlots: [],
    expiresAt: null,
    lastError: "reschedule_pending_business_approval",
  });

  return {
    handled: true,
    result: fixedResult({
      reply: `I’ve submitted your request to move the appointment to ${requestedTime}. Your existing appointment remains confirmed until the business approves the change.`,
    }),
  };
}
