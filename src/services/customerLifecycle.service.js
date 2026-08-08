import Alert from "../models/alert.js";
import Appointment from "../models/appointment.js";
import Conversation from "../models/conversation.js";
import Lead from "../models/lead.js";
import VoiceSession from "../models/voiceSession.js";
import { deriveCanonicalLifecycle } from "../helpers/customerLifecycle.js";

export const syncCustomerLifecycle = async ({
  businessId,
  lead,
  conversations = [],
  appointments = [],
  voiceSessions = [],
}) => {
  const leadId = lead?._id || lead?.id;
  if (!businessId || !leadId) return deriveCanonicalLifecycle({ lead, conversations, appointments, voiceSessions });

  const customerLifecycleStatus = deriveCanonicalLifecycle({
    lead,
    conversations,
    appointments,
    voiceSessions,
  });
  const conversationIds = conversations.map((item) => item?._id).filter(Boolean);
  const appointmentIds = appointments.map((item) => item?._id).filter(Boolean);
  const voiceSessionIds = voiceSessions.map((item) => item?._id).filter(Boolean);

  await Promise.all([
    Lead.updateOne(
      { _id: leadId, business: businessId },
      { $set: { customerLifecycleStatus } },
    ),
    conversationIds.length
      ? Conversation.updateMany(
          { _id: { $in: conversationIds }, business: businessId },
          { $set: { customerLifecycleStatus } },
        )
      : null,
    appointmentIds.length
      ? Appointment.updateMany(
          { _id: { $in: appointmentIds }, business: businessId },
          { $set: { customerLifecycleStatus } },
        )
      : null,
    voiceSessionIds.length
      ? VoiceSession.updateMany(
          { _id: { $in: voiceSessionIds }, business: businessId },
          { $set: { customerLifecycleStatus } },
        )
      : null,
    Alert.updateMany(
      {
        business: businessId,
        $or: [
          { lead: leadId },
          ...(conversationIds.length ? [{ conversation: { $in: conversationIds } }] : []),
          ...(appointmentIds.length ? [{ appointment: { $in: appointmentIds } }] : []),
        ],
      },
      { $set: { customerLifecycleStatus } },
    ),
  ].filter(Boolean));

  return customerLifecycleStatus;
};

export default { syncCustomerLifecycle };
