import Appointment from "../../../models/appointment.js";
import Message from "../../../models/message.js";
import VoiceSession from "../../../models/voiceSession.js";
import { sendSms } from "../../../services/twilioSmsService.js";
import { isSmsSuppressed } from "../../../services/messaging/contactPreference.service.js";
import SocketService from "../../../services/socket.service.js";

import { assertVoiceTurnActive } from "../../../services/voiceTurnContext.service.js";
const formatAppointment = (appointment) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: appointment.timezone || "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(appointment.startAt));

const claimDelivery = async (voiceSessionId) => {
  if (!voiceSessionId) {
    const error = new Error("voiceSessionId is required for an idempotent voice confirmation SMS.");
    error.statusCode = 400;
    throw error;
  }

  return VoiceSession.findOneAndUpdate(
    {
      _id: voiceSessionId,
      $or: [
        { confirmationSmsStatus: { $in: ["pending", "failed"] } },
        { confirmationSmsStatus: { $exists: false } },
      ],
    },
    {
      $set: {
        confirmationSmsStatus: "sending",
        confirmationSmsProviderMessageId: "",
      },
    },
    { new: true },
  );
};

const updateDelivery = (voiceSessionId, changes) =>
  VoiceSession.updateOne(
    { _id: voiceSessionId },
    { $set: changes },
  );

const suppressDelivery = async ({ voiceSessionId, reason, body }) => {
  await updateDelivery(voiceSessionId, {
    confirmationSmsStatus: "suppressed",
    confirmationSmsSentAt: null,
    confirmationSmsProviderMessageId: "",
  });
  return { sent: false, suppressed: true, reason, body };
};

const sendConfirmationSmsTool = async ({
  business,
  lead,
  conversation,
  appointmentId,
  voiceSessionId,
}) => {
  assertVoiceTurnActive();
  const claimedSession = await claimDelivery(voiceSessionId);
  if (!claimedSession) {
    return {
      sent: false,
      duplicate: true,
      reason: "A confirmation SMS was already sent or is currently being sent for this voice session.",
    };
  }

  const appointment = await Appointment.findOne({
    _id: appointmentId,
    business: business._id,
    status: "confirmed",
  });
  if (!appointment) {
    await updateDelivery(voiceSessionId, { confirmationSmsStatus: "failed" });
    const error = new Error("Confirmed appointment was not found.");
    error.statusCode = 404;
    throw error;
  }

  const to = lead?.phone || conversation?.customerPhone;
  const from = business.phone;
  const body = `You’re confirmed for ${formatAppointment(
    appointment,
  )} for ${lead?.serviceNeeded || "your service request"}. Final scope and pricing may require technician evaluation. Reply here if you need to cancel or reschedule.`;

  if (!to || !from) {
    return suppressDelivery({
      voiceSessionId,
      reason: "A valid caller or business phone number was unavailable.",
      body,
    });
  }

  try {
    if (
      await isSmsSuppressed({
        businessId: business._id,
        phone: to,
      })
    ) {
      return suppressDelivery({
        voiceSessionId,
        reason: "The caller opted out of SMS messages.",
        body,
      });
    }
  } catch (error) {
    console.error("Voice confirmation SMS preference check failed:", error);
    return suppressDelivery({
      voiceSessionId,
      reason:
        "SMS preference status could not be verified, so delivery was suppressed.",
      body,
    });
  }

  let sent;
  try {
    assertVoiceTurnActive();
    sent = await sendSms({ to, from, body });
  } catch (error) {
    await updateDelivery(voiceSessionId, {
      confirmationSmsStatus: "failed",
      confirmationSmsSentAt: null,
      confirmationSmsProviderMessageId: "",
    });
    throw error;
  }

  const providerMessageId = sent?.sid || "";
  await updateDelivery(voiceSessionId, {
    confirmationSmsStatus: "sent",
    confirmationSmsSentAt: new Date(),
    confirmationSmsProviderMessageId: providerMessageId,
  });

  let message = null;
  try {
    message = await Message.create({
      business: business._id,
      conversation: conversation._id,
      lead: lead?._id || null,
      direction: "outbound",
      from,
      to,
      body,
      provider: "twilio",
      providerMessageId,
      status: "sent",
      isAiGenerated: false,
      metadata: {
        appointmentId: appointment._id,
        source: "voice",
        voiceSessionId,
      },
    });
  } catch (error) {
    // The provider accepted the SMS. Keep the session marked sent so a database
    // logging failure cannot cause a duplicate customer message on retry.
    console.error("Voice confirmation SMS was sent but could not be logged:", error);
  }

  if (message && typeof SocketService.emitMessageCreated === "function") {
    SocketService.emitMessageCreated(business._id, message);
  }
  if (conversation) {
    conversation.lastMessage = body;
    conversation.lastMessageAt = new Date();
    await conversation.save();
    if (typeof SocketService.emitConversationUpdated === "function") {
      SocketService.emitConversationUpdated(business._id, conversation);
    }
  }
  if (typeof SocketService.emitDashboardRefresh === "function") {
    SocketService.emitDashboardRefresh(
      business._id,
      "voice_booking_confirmation_sms_sent",
    );
  }

  return {
    sent: true,
    providerMessageId,
    body,
    messagePersisted: Boolean(message),
  };
};

export default sendConfirmationSmsTool;
