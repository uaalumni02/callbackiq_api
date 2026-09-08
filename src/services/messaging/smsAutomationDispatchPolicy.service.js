import Business from "../../models/business.js";
import Conversation from "../../models/conversation.js";
import { isBusinessFeatureEnabled } from "../../helpers/businessFeatures.js";

// Read authoritative ownership at dispatch, after slow AI/provider preparation.
// A generated reply is not permission to send once a person takes ownership.
export const getSmsAutomationSuppressionReason = async ({
  businessId, conversationId, leadId, to, isAiGenerated = true,
}) => {
  if (!businessId || !conversationId) return "automation_context_missing";
  const [business, conversation] = await Promise.all([
    Business.findById(businessId),
    Conversation.findOne({ _id: conversationId, business: businessId }),
  ]);
  if (!business || !conversation) return "automation_context_missing";
  if (business.isActive === false) return "business_inactive";
  if (conversation.humanTakeover === true) return "human_takeover";
  if (["closed", "archived"].includes(conversation.status)) return "conversation_inactive";
  if (conversation.aiEnabled === false) return "conversation_ai_disabled";
  if (leadId && String(conversation.lead) !== String(leadId)) return "automation_context_changed";
  if (to && conversation.customerPhone !== to) return "automation_context_changed";
  if (isAiGenerated && !isBusinessFeatureEnabled(business, "aiQualificationEnabled")) {
    return "business_ai_disabled";
  }
  return "";
};
