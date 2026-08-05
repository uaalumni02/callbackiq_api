import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import Alert from "../models/alert.js";
import agentReplySchema from "../validator/agent.js";
import { runFollowUpAgent } from "../helpers/ai/followUpAgent.js";
import { isBusinessFeatureEnabled } from "../helpers/businessFeatures.js";
import * as Response from "../helpers/response/response.js";
import { sendSms } from "../services/twilioSmsService.js";
import { reserveAiUsage } from "../services/communicationUsage.service.js";
import { logOperationalError } from "../helpers/logging/safeLogger.js";

const sanitizeUrgency = (urgency) => {
  const allowed = ["low", "medium", "high", "emergency"];
  return allowed.includes(urgency) ? urgency : "medium";
};

const sanitizeScore = (score) => {
  const numberScore = Number(score);
  if (Number.isNaN(numberScore)) return 50;
  return Math.min(100, Math.max(0, numberScore));
};

const sanitizeEstimatedValue = (value) => {
  const numberValue = Number(value);
  if (Number.isNaN(numberValue)) return 0;
  return Math.max(0, numberValue);
};

const shouldCreateHotLeadAlert = (agentResult) =>
  agentResult.shouldAlertOwner === true ||
  agentResult.urgency === "emergency" ||
  Number(agentResult.leadQualityScore) >= 85;

class AgentController {
  static async replyToConversation(req, res) {
    try {
      const ownerId = req.user?.userId;
      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await agentReplySchema.validateAsync(req.body);
      const { conversationId, leadId, customerMessage } = req.body;

      if (!mongoose.isValidObjectId(conversationId)) {
        return Response.responseInvalidInput(res, "Invalid conversation ID");
      }
      if (leadId && !mongoose.isValidObjectId(leadId)) {
        return Response.responseInvalidInput(res, "Invalid lead ID");
      }

      const business =
        req.business || (await Db.getBusinessByOwner(Business, ownerId));
      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }
      if (!isBusinessFeatureEnabled(business, "aiQualificationEnabled")) {
        return res.status(403).json({
          success: false,
          message: "AI qualification is not enabled for this business.",
        });
      }

      const conversation = await Db.getConversationById(
        Conversation,
        conversationId,
      );
      if (!conversation) {
        return Response.responseInvalidInput(res, "Conversation not found");
      }
      if (String(conversation.business?._id || conversation.business) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot access this conversation",
        );
      }

      let lead = null;
      if (leadId) {
        lead = await Db.getLeadForBusiness(Lead, leadId, business._id);
        if (!lead) {
          return Response.responseInvalidInput(res, "Lead not found");
        }
      } else if (conversation.lead?._id || conversation.lead) {
        lead = await Db.getLeadForBusiness(
          Lead,
          conversation.lead._id || conversation.lead,
          business._id,
        );
      }

      const recentMessages = await Db.getMessagesByConversation(
        Message,
        conversationId,
      );
      const aiUsage = await reserveAiUsage({
        business,
        customerPhone: conversation.customerPhone,
      });
      if (!aiUsage.allowed) {
        return res.status(429).json({
          success: false,
          message:
            "The AI reply allowance has been reached. The conversation was not changed.",
          data: {
            reason: aiUsage.reason,
            scope: aiUsage.scope || null,
            window: aiUsage.window || null,
          },
        });
      }

      const inboundMessage = await Db.saveMessage(Message, {
        business: business._id,
        conversation: conversation._id,
        lead: lead?._id || null,
        direction: "inbound",
        from: conversation.customerPhone,
        to: business.phone,
        body: customerMessage,
        provider: "manual",
        status: "received",
        actorType: "user",
        actorId: ownerId,
        usageCategory: "agent_reply_input",
        metadata: { source: "agent_reply_endpoint" },
      });

      const agentResult = await runFollowUpAgent({
        business,
        businessName: business.businessName,
        businessType: business.businessType,
        customerMessage,
        lead: lead || {},
        recentMessages,
      });

      const aiReply =
        agentResult.reply ||
        "Thanks for the details. I’ll send this to the owner so they can follow up.";

      let updatedLead = lead;
      if (lead) {
        const updateData = {
          serviceNeeded:
            agentResult.serviceNeeded ||
            lead.serviceNeeded ||
            "Unknown service",
          urgency: sanitizeUrgency(agentResult.urgency),
          address: agentResult.address || lead.address || "",
          preferredAppointmentTime:
            agentResult.preferredAppointmentTime ||
            lead.preferredAppointmentTime ||
            "",
          leadQualityScore: sanitizeScore(agentResult.leadQualityScore),
          estimatedValue: sanitizeEstimatedValue(agentResult.estimatedValue),
          summary: agentResult.summary || lead.summary || "",
          status: lead.status === "booked" ? "booked" : "contacted",
        };
        updatedLead = await Db.qualifyLead(Lead, lead._id, updateData);
      }

      let smsSent = false;
      let smsSuppressed = false;
      let smsFailureReason = "";
      let providerMessageId = "";

      try {
        const sentMessage = await sendSms({
          business,
          businessId: business._id,
          from: business.phone,
          to: conversation.customerPhone,
          body: aiReply,
          actorId: ownerId,
          actorType: "user",
          source: "agent_reply",
          directResponse: true,
          usageCategory: "ai_reply",
          conversationId: conversation._id,
          leadId: updatedLead?._id || null,
          metadata: { aiGenerated: true, generatedBy: "ai" },
        });
        smsSuppressed = sentMessage?.suppressed === true;
        smsFailureReason = sentMessage?.reason || "";
        smsSent = !smsSuppressed && Boolean(sentMessage?.sid);
        providerMessageId = sentMessage?.sid || "";
      } catch (smsError) {
        smsFailureReason = smsError?.code || smsError?.message || "provider_error";
        logOperationalError("agent_reply.sms_failed", smsError, {
          businessId: business._id,
          conversationId: conversation._id,
        });
      }

      const outboundMessage = await Db.saveMessage(Message, {
        business: business._id,
        conversation: conversation._id,
        lead: updatedLead?._id || null,
        direction: "outbound",
        from: business.phone,
        to: conversation.customerPhone,
        body: aiReply,
        provider: smsSent ? "twilio" : "system",
        providerMessageId,
        status: smsSent ? "sent" : "failed",
        isAiGenerated: true,
        generatedBy: "ai",
        usageCategory: "ai_reply",
        actorType: "ai",
        actorId: ownerId,
        metadata: {
          aiGenerated: true,
          source: "agent_reply_endpoint",
          smsSuppressed,
          smsFailureReason,
        },
      });

      await Db.updateConversation(Conversation, conversation._id, {
        lastMessage: aiReply,
        lastMessageAt: new Date(),
      });

      let alert = null;
      if (updatedLead && shouldCreateHotLeadAlert(agentResult)) {
        alert = await Db.saveAlert(Alert, {
          business: business._id,
          lead: updatedLead._id,
          type: "hot_lead",
          channel: "in_app",
          title: agentResult.alertTitle || "New hot lead",
          message:
            agentResult.alertMessage ||
            agentResult.summary ||
            "A customer may need urgent service.",
          status: "pending",
          priority:
            sanitizeUrgency(agentResult.urgency) === "emergency"
              ? "high"
              : "medium",
          metadata: {
            source: "ai_follow_up_agent",
            conversation: conversation._id,
            inboundMessage: inboundMessage._id,
            outboundMessage: outboundMessage._id,
          },
        });
      }

      return Response.responseOk(
        res,
        {
          reply: aiReply,
          lead: updatedLead,
          inboundMessage,
          outboundMessage,
          alert,
          smsSent,
          smsSuppressed,
          smsFailureReason,
        },
        "Agent reply processed successfully",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }
      logOperationalError("agent_reply.failed", error, {
        businessId: req.business?._id,
        conversationId: req.body?.conversationId,
      });
      return Response.responseServerError(res);
    }
  }
}

export default AgentController;
