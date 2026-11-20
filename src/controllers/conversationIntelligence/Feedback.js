import {readTenantResource} from '../shared/tenantResource.js';
import Business from "../../models/business.js";
import ConversationIntelligence from "../../models/conversationIntelligence.js";
import Db from "../../db/db.js";
import * as Response from "../../helpers/response/response.js";
import SocketService from "../../services/socket.service.js";
import { actionSchema, feedbackSchema } from "../../validator/conversationIntelligence.js";
import mongoose from "mongoose";
import { safeConsole } from "../../helpers/logging/safeLogger.js";

export default class ConversationIntelligenceFeedbackController {
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

      const existing=await readTenantResource({model:ConversationIntelligence,businessId:business._id,id:conversationId,res,
        missingMessage:"Conversation intelligence not found",deniedMessage:"You cannot update this conversation intelligence",
        identityField:'conversation'});
      if(!existing)return undefined;

      const updated = await Db.updateConversationIntelligenceForBusiness(
        ConversationIntelligence,
        conversationId,
        business._id,
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
      safeConsole.error("Error in updateFeedback:", error);

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

      const existing=await readTenantResource({model:ConversationIntelligence,businessId:business._id,id:conversationId,res,
        missingMessage:"Conversation intelligence not found",deniedMessage:"You cannot update this recommended action",
        identityField:'conversation'});
      if(!existing)return undefined;

      const updated = await Db.updateConversationIntelligenceForBusiness(
        ConversationIntelligence,
        conversationId,
        business._id,
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
      safeConsole.error("Error in updateRecommendedAction:", error);

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

      const existing=await readTenantResource({model:ConversationIntelligence,businessId:business._id,id:conversationId,res,
        missingMessage:"Conversation intelligence not found",deniedMessage:"You cannot delete this conversation intelligence",
        identityField:'conversation'});
      if(!existing)return undefined;

      await Db.deleteConversationIntelligenceForBusiness(
        ConversationIntelligence,
        conversationId,
        business._id,
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
      safeConsole.error("Error in deleteConversationIntelligence:", error);

      return Response.responseServerError(res);
    }
  }
}
