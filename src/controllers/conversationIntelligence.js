import mongoose from "mongoose";

import Db from "../db/db.js";

import Business from "../models/business.js";
import Conversation from "../models/conversation.js";
import ConversationIntelligence from "../models/conversationIntelligence.js";
import Lead from "../models/lead.js";
import Message from "../models/message.js";

import {
  analyzeConversationSchema,
  feedbackSchema,
  actionSchema,
  opportunityQuerySchema,
  listQuerySchema,
} from "../validator/conversationIntelligence.js";

import * as Response from "../helpers/response/response.js";

import ConversationIntelligenceService from "../services/conversationIntelligence.service.js";
import SocketService from "../services/socket.service.js";

class ConversationIntelligenceController {
  static async analyzeConversation(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { conversationId } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(conversationId)) {
        return Response.responseInvalidInput(res, "Invalid conversation ID");
      }

      const { force } = await analyzeConversationSchema.validateAsync(
        req.body || {},
      );

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
          "You cannot analyze this conversation",
        );
      }

      const existing = await Db.getConversationIntelligenceDocument(
        ConversationIntelligence,
        conversationId,
      );

      if (existing?.status === "processing" && !force) {
        return Response.responseInvalidInput(
          res,
          "Conversation analysis is already in progress",
        );
      }

      const lead = conversation.lead
        ? await Db.getLeadById(Lead, conversation.lead._id || conversation.lead)
        : null;

      const messages = await Db.getMessagesByConversation(
        Message,
        conversationId,
      );

      if (!messages?.length) {
        return Response.responseInvalidInput(
          res,
          "Conversation does not contain any messages",
        );
      }

      await Db.saveConversationIntelligence(ConversationIntelligence, {
        business: business._id,
        conversation: conversation._id,
        lead: lead?._id || null,
        status: "processing",
        errorMessage: "",
      });

      try {
        const analysis = await ConversationIntelligenceService.analyze({
          business,
          conversation,
          lead,
          messages,
        });

        const intelligence = await Db.saveConversationIntelligence(
          ConversationIntelligence,
          {
            ...analysis,
            business: business._id,
            conversation: conversation._id,
            lead: lead?._id || null,
            status: "completed",
            sourceMessageCount: messages.length,
            lastMessageAnalyzedAt:
              messages[messages.length - 1]?.createdAt || new Date(),
            errorMessage: "",
          },
        );

        if (lead) {
          await Db.updateLead(Lead, lead._id, {
            summary: intelligence.summary,
            leadQualityScore: intelligence.buyingLikelihood.score,
            estimatedValue: intelligence.estimatedRevenue.likely,
            urgency:
              intelligence.urgency.level === "normal"
                ? "medium"
                : intelligence.urgency.level === "unknown"
                  ? lead.urgency
                  : intelligence.urgency.level,
          });
        }

        SocketService.emitToBusiness(
          business._id,
          "conversation-intelligence:updated",
          intelligence,
        );

        SocketService.emitDashboardRefresh(
          business._id,
          "conversation_intelligence_updated",
        );

        return Response.responseOk(
          res,
          intelligence,
          "Conversation analyzed successfully",
        );
      } catch (analysisError) {
        await Db.updateConversationIntelligence(
          ConversationIntelligence,
          conversationId,
          {
            status: "failed",
            errorMessage: "Unable to analyze conversation",
          },
        );

        throw analysisError;
      }
    } catch (error) {
      console.error("Error in analyzeConversation:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
  }

  static async getMyConversationIntelligence(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const filters = await listQuerySchema.validateAsync(req.query, {
        convert: true,
      });

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const result = await Db.getConversationIntelligenceByBusiness(
        ConversationIntelligence,
        business._id,
        filters,
      );

      return Response.responseOk(
        res,
        result,
        "Conversation intelligence fetched",
      );
    } catch (error) {
      console.error("Error in getMyConversationIntelligence:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
  }

  static async getConversationIntelligence(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { conversationId } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(conversationId)) {
        return Response.responseInvalidInput(res, "Invalid conversation ID");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const intelligence = await Db.getConversationIntelligenceByConversation(
        ConversationIntelligence,
        conversationId,
      );

      if (!intelligence) {
        return Response.responseInvalidInput(
          res,
          "Conversation intelligence not found",
        );
      }

      if (String(intelligence.business) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot access this conversation intelligence",
        );
      }

      return Response.responseOk(
        res,
        intelligence,
        "Conversation intelligence fetched",
      );
    } catch (error) {
      console.error("Error in getConversationIntelligence:", error);

      return Response.responseServerError(res);
    }
  }

  static async getOpportunities(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const validatedQuery = await opportunityQuerySchema.validateAsync(
        req.query,
        {
          convert: true,
        },
      );

      const filters = {
        ...validatedQuery,
        urgency: validatedQuery.urgency
          ? validatedQuery.urgency.split(",")
          : undefined,
      };

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const result = await Db.getConversationIntelligenceOpportunities(
        ConversationIntelligence,
        business._id,
        filters,
      );

      return Response.responseOk(res, result, "AI opportunities fetched");
    } catch (error) {
      console.error("Error in getOpportunities:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
  }

  static async getDashboard(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const dashboard = await Db.getConversationIntelligenceDashboard(
        ConversationIntelligence,
        business._id,
      );

      return Response.responseOk(
        res,
        dashboard,
        "Conversation intelligence dashboard fetched",
      );
    } catch (error) {
      console.error("Error in getDashboard:", error);

      return Response.responseServerError(res);
    }
  }

  static async updateFeedback(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { conversationId } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(conversationId)) {
        return Response.responseInvalidInput(res, "Invalid conversation ID");
      }

      const feedback = await feedbackSchema.validateAsync(req.body);

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const existing = await Db.getConversationIntelligenceDocument(
        ConversationIntelligence,
        conversationId,
      );

      if (!existing) {
        return Response.responseInvalidInput(
          res,
          "Conversation intelligence not found",
        );
      }

      if (String(existing.business) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot update this conversation intelligence",
        );
      }

      const updated = await Db.updateConversationIntelligence(
        ConversationIntelligence,
        conversationId,
        {
          feedback: {
            ...feedback,
            submittedBy: ownerId,
            submittedAt: new Date(),
          },
        },
      );

      SocketService.emitToBusiness(
        business._id,
        "conversation-intelligence:feedback-updated",
        updated,
      );

      return Response.responseOk(
        res,
        updated,
        "Conversation intelligence feedback updated",
      );
    } catch (error) {
      console.error("Error in updateFeedback:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
  }

  static async updateRecommendedAction(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { conversationId } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(conversationId)) {
        return Response.responseInvalidInput(res, "Invalid conversation ID");
      }

      const { completed, outcome = "" } = await actionSchema.validateAsync(
        req.body,
      );

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const existing = await Db.getConversationIntelligenceDocument(
        ConversationIntelligence,
        conversationId,
      );

      if (!existing) {
        return Response.responseInvalidInput(
          res,
          "Conversation intelligence not found",
        );
      }

      if (String(existing.business) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot update this recommended action",
        );
      }

      const updated = await Db.updateConversationIntelligence(
        ConversationIntelligence,
        conversationId,
        {
          "nextBestAction.completed": completed,
          "nextBestAction.completedAt": completed ? new Date() : null,
          "nextBestAction.outcome": outcome,
        },
      );

      SocketService.emitToBusiness(
        business._id,
        "conversation-intelligence:action-updated",
        updated,
      );

      SocketService.emitDashboardRefresh(
        business._id,
        "conversation_intelligence_action_updated",
      );

      return Response.responseOk(res, updated, "Recommended action updated");
    } catch (error) {
      console.error("Error in updateRecommendedAction:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
  }

  static async deleteConversationIntelligence(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { conversationId } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(conversationId)) {
        return Response.responseInvalidInput(res, "Invalid conversation ID");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const existing = await Db.getConversationIntelligenceDocument(
        ConversationIntelligence,
        conversationId,
      );

      if (!existing) {
        return Response.responseInvalidInput(
          res,
          "Conversation intelligence not found",
        );
      }

      if (String(existing.business) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot delete this conversation intelligence",
        );
      }

      await Db.deleteConversationIntelligence(
        ConversationIntelligence,
        conversationId,
      );

      SocketService.emitToBusiness(
        business._id,
        "conversation-intelligence:deleted",
        {
          conversationId,
          deletedAt: new Date().toISOString(),
        },
      );

      SocketService.emitDashboardRefresh(
        business._id,
        "conversation_intelligence_deleted",
      );

      return res.status(200).json({
        success: true,
        message: "Conversation intelligence deleted successfully",
      });
    } catch (error) {
      console.error("Error in deleteConversationIntelligence:", error);

      return Response.responseServerError(res);
    }
  }
}

export default ConversationIntelligenceController;
