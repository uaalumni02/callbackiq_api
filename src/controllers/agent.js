import mongoose from "mongoose";
import twilio from "twilio";

import Db from "../db/db.js";
import Business from "../models/business.js";
import Lead from "../models/lead.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import Alert from "../models/alert.js";
import agentReplySchema from "../validator/agent.js";
import { runFollowUpAgent } from "../helpers/ai/followUpAgent.js";
import * as Response from "../helpers/response/response.js";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

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

const shouldCreateHotLeadAlert = (agentResult) => {
  return (
    agentResult.shouldAlertOwner === true ||
    agentResult.urgency === "emergency" ||
    Number(agentResult.leadQualityScore) >= 85
  );
};

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

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const conversation = await Db.getConversationById(
        Conversation,
        conversationId,
      );

      if (!conversation) {
        return Response.responseInvalidInput(res, "Conversation not found");
      }

      if (String(conversation.business._id) !== String(business._id)) {
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
      });

      const agentResult = await runFollowUpAgent({
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
      let providerMessageId = "";

      try {
        if (process.env.TWILIO_PHONE_NUMBER) {
          const sentMessage = await client.messages.create({
            from: process.env.TWILIO_PHONE_NUMBER,
            to: conversation.customerPhone,
            body: aiReply,
          });

          smsSent = true;
          providerMessageId = sentMessage.sid;
        }
      } catch (smsError) {
        console.error("Error sending agent SMS:", smsError.message);
      }

      const outboundMessage = await Db.saveMessage(Message, {
        business: business._id,
        conversation: conversation._id,
        lead: updatedLead?._id || null,
        direction: "outbound",
        from: process.env.TWILIO_PHONE_NUMBER || business.phone,
        to: conversation.customerPhone,
        body: aiReply,
        provider: process.env.TWILIO_PHONE_NUMBER ? "twilio" : "system",
        providerMessageId,
        status: smsSent ? "sent" : "failed",
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
        },
        "Agent reply processed successfully",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in replyToConversation:", error);
      return Response.responseServerError(res);
    }
  }
}

export default AgentController;
