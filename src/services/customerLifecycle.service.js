import { syncCustomerLifecycleLeadUpdateOne, syncCustomerLifecycleConversationUpdateMany, syncCustomerLifecycleAppointmentUpdateMany, syncCustomerLifecycleAlertUpdateMany } from './stateTransitions/customerProjections.js';
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
    syncCustomerLifecycleLeadUpdateOne({ Lead, businessId, customerLifecycleStatus, leadId }),
    conversationIds.length
      ? syncCustomerLifecycleConversationUpdateMany({ Conversation, businessId, conversationIds, customerLifecycleStatus })
      : null,
    appointmentIds.length
      ? syncCustomerLifecycleAppointmentUpdateMany({ Appointment, appointmentIds, businessId, customerLifecycleStatus })
      : null,
    voiceSessionIds.length
      ? VoiceSession.updateMany(
          { _id: { $in: voiceSessionIds }, business: businessId },
          { $set: { customerLifecycleStatus } },
        )
      : null,
    syncCustomerLifecycleAlertUpdateMany({ Alert, appointmentIds, businessId, conversationIds, customerLifecycleStatus, leadId }),
  ].filter(Boolean));

  return customerLifecycleStatus;
};

export default { syncCustomerLifecycle };
