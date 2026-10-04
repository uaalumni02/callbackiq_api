import { smsContactControlKind, canAcknowledgeSmsContactControl } from './smsContactControl.service.js';
import Business from "../../models/business.js";
import Conversation from "../../models/conversation.js";
import { isBusinessFeatureEnabled } from "../../helpers/businessFeatures.js";

// Read authoritative ownership at dispatch, after slow AI/provider preparation.
// A generated reply is not permission to send once a person takes ownership.
export const getSmsAutomationSuppressionReason = async ({
  businessId, conversationId, leadId, to, isAiGenerated = true, contactControl = '', customerMessage = '', fixedEmergencyReply = false,
}) => {
  if (!businessId || !conversationId) return "automation_context_missing";
  const [business, conversation] = await Promise.all([
    Business.findById(businessId),
    Conversation.findOne({ _id: conversationId, business: businessId }),
  ]);
  if (!business || !conversation) return "automation_context_missing";
  if (business.isActive === false) return "business_inactive";
  const controlAllowed = !isAiGenerated && Boolean(contactControl) &&
    smsContactControlKind(customerMessage) === contactControl &&
    canAcknowledgeSmsContactControl(conversation);
  const emergencyAllowed = !isAiGenerated && fixedEmergencyReply === true;
  if (conversation.humanTakeover === true && !controlAllowed && !emergencyAllowed) return "human_takeover";
  if (["closed", "archived"].includes(conversation.status)) return "conversation_inactive";
  if (conversation.aiEnabled === false && !controlAllowed && !emergencyAllowed) return "conversation_ai_disabled";
  if (leadId && String(conversation.lead) !== String(leadId)) return "automation_context_changed";
  if (to && conversation.customerPhone !== to) return "automation_context_changed";
  if (isAiGenerated && !isBusinessFeatureEnabled(business, "aiQualificationEnabled")) {
    return "business_ai_disabled";
  }
  return "";
};
