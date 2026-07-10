import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import conversationValidator from "../validator/conversation.js";
import * as Response from "../helpers/response/response.js";
import SocketService from "../services/socket.service.js";

class ConversationController {
  static async createConversation(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await conversationValidator.validateAsync(req.body);

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const conversation = await Db.saveConversation(Conversation, {
        ...req.body,
        business: business._id,
      });

      SocketService.emitConversationCreated(business._id, conversation);

      SocketService.emitDashboardRefresh(business._id, "conversation_created");

      return res.status(201).json({
        success: true,
        message: "Conversation created successfully",
        data: conversation,
      });
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in createConversation:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMyConversations(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const conversations = await Db.getConversationsByBusiness(
        Conversation,
        business._id,
      );

      return Response.responseOk(res, conversations, "Conversations fetched");
    } catch (error) {
      console.error("Error in getMyConversations:", error);
      return Response.responseServerError(res);
    }
  }

  static async getConversationById(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid conversation ID");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const conversation = await Db.getConversationById(Conversation, id);

      if (!conversation) {
        return Response.responseInvalidInput(res, "Conversation not found");
      }

      if (String(conversation.business._id) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot access this conversation",
        );
      }

      return Response.responseOk(res, conversation, "Conversation fetched");
    } catch (error) {
      console.error("Error in getConversationById:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateConversation(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid conversation ID");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const conversation = await Db.getConversationById(Conversation, id);

      if (!conversation) {
        return Response.responseInvalidInput(res, "Conversation not found");
      }

      if (String(conversation.business._id) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot update this conversation",
        );
      }

      const updatedConversation = await Db.updateConversation(
        Conversation,
        id,
        req.body,
      );

      SocketService.emitConversationUpdated(business._id, updatedConversation);

      SocketService.emitDashboardRefresh(business._id, "conversation_updated");

      return Response.responseOk(
        res,
        updatedConversation,
        "Conversation updated successfully",
      );
    } catch (error) {
      console.error("Error in updateConversation:", error);
      return Response.responseServerError(res);
    }
  }

  static async deleteConversation(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid conversation ID");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const conversation = await Db.getConversationById(Conversation, id);

      if (!conversation) {
        return Response.responseInvalidInput(res, "Conversation not found");
      }

      if (String(conversation.business._id) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot delete this conversation",
        );
      }

      await Message.deleteMany({ conversation: id });
      await Db.deleteConversation(Conversation, id);

      SocketService.emitToBusiness(business._id, "conversation:deleted", {
        conversationId: id,
        deletedAt: new Date().toISOString(),
      });

      SocketService.emitDashboardRefresh(business._id, "conversation_deleted");

      return res.status(200).json({
        success: true,
        message: "Conversation deleted successfully",
      });
    } catch (error) {
      console.error("Error in deleteConversation:", error);
      return Response.responseServerError(res);
    }
  }
}

export default ConversationController;
