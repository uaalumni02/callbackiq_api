import Appointment from "../../models/appointment.js";
import cancelAppointmentTool from "../../helpers/ai/tools/cancelAppointment.tool.js";
import { isRequestWithdrawal } from "../conversationControlPolicy.js";
import { renderAppointmentResponse } from "../scheduling/customerAppointmentPresentation.service.js";
import { fixedResult } from "./bookingFixedResult.policy.js";

export async function handleExistingBookingTurn({
  status,
  activeConversation,
  business,
  bookingChannel,
  text,
  formatSlot,
  saveBookingTransition,
}) {
  if (status === "pending_business_confirmation") {
    const appointmentId = activeConversation.bookingState.appointment;
    const appointment = appointmentId
      ? await Appointment.findOne({
          _id: appointmentId,
          business: business._id,
        })
      : null;

    if (appointment?.status === 'failed' && /hold expired/i.test(appointment.failureReason || '')) {
      await saveBookingTransition(activeConversation, "approval_recheck_requested");
      return { handled: true, result: fixedResult({ reply: renderAppointmentResponse({ kind: 'expired' }, bookingChannel) }) };
    }
    if (appointment?.status === "confirmed") {
      await saveBookingTransition(activeConversation, "approval_observed");
      return {
        handled: true,
        result: fixedResult({
          reply: `Your appointment is confirmed for ${formatSlot(
            appointment,
            appointment.timezone,
          )}. Reply here if you need to reschedule or cancel.`,
        }),
      };
    }

    if (appointment?.status === "held") {
      return {
        handled: true,
        result: fixedResult({
          reply:
            "Your requested appointment is still awaiting business approval. It is not confirmed yet. I can’t guarantee a confirmation call or a response time.",
        }),
      };
    }

    await saveBookingTransition(activeConversation, "approval_unavailable");
    return {
      handled: true,
      result: fixedResult({
        reply:
          "That appointment request could not be confirmed. What other day or time works for you?",
      }),
    };
  }

  if (status === "booked") {
    const appointmentId = activeConversation.bookingState.appointment;

    // Destructive or schedule-changing intent takes precedence over a casual
    // affirmative word (for example, "sure, but I need to reschedule").
    if (isRequestWithdrawal(text)) {
      try {
        await cancelAppointmentTool({
          business,
          appointmentId,
          reason: `Customer requested cancellation by ${
            bookingChannel === "sms" ? "SMS" : "voice"
          }.`,
        });
        await saveBookingTransition(activeConversation, "booking_canceled");

        return {
          handled: true,
          result: fixedResult({
            reply:
              "Your appointment has been canceled. Reply with a new preferred day if you’d like to reschedule.",
          }),
        };
      } catch (error) {
        return {
          handled: true,
          result: fixedResult({
            reply:
              "I couldn’t confirm the cancellation automatically. I’ve alerted the team to handle it directly.",
          }),
        };
      }
    }

    if (
      /^\s*r\s*$/i.test(text) ||
      /\breschedule|change (?:the )?(?:time|day|appointment)\b/i.test(text)
    ) {
      await Appointment.updateOne(
        { _id: appointmentId, business: business._id },
        { $set: { customerRescheduleRequestedAt: new Date() } },
      );
      await saveBookingTransition(activeConversation, "reschedule_requested");

      return {
        handled: true,
        result: fixedResult({
          reply:
            "What new day and time would you prefer? You can text naturally—for example: tomorrow at 2, next Friday morning, or day after tomorrow around 3ish.",
        }),
      };
    }

    // Reminder messages explicitly ask for C or R. Do not treat a repeated
    // conversational YES after booking as a second confirmation action.
    if (/^\s*c\s*$/i.test(text)) {
      const confirmed = await Appointment.findOneAndUpdate(
        {
          _id: appointmentId,
          business: business._id,
          status: "confirmed",
        },
        {
          $set: { customerConfirmedAt: new Date() },
        },
        { returnDocument: "after" },
      );
      if (confirmed) {
        return {
          handled: true,
          result: fixedResult({
            reply: `Thank you—your appointment for ${formatSlot(
              confirmed,
              confirmed.timezone,
            )} is confirmed.`,
          }),
        };
      }
    }

    return { handled: false };
  }

  return { handled: false };
}
