import { handleConversationManualMessage } from "../services/messaging/manualConversationMessage.service.js";
import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import messageValidator from "../validator/message.js";
import * as Response from "../helpers/response/response.js";
import SocketService from "../services/socket.service.js";

const getBusinessForOwner = async (ownerId) => {
  return typeof Db.getBusinessScopeByOwner === "function"
    ? Db.getBusinessScopeByOwner(Business, ownerId)
    : Db.getBusinessByOwner(Business, ownerId);
};

const deleteMessageForBusiness = async (id, businessId) => {
  if (typeof Db.deleteMessageForBusiness === "function") {
    return Db.deleteMessageForBusiness(Message, id, businessId);
  }

  return Db.deleteMessage(Message, id);
};


class MessageController {
  static async createMessage(req, res) {
    return handleConversationManualMessage(req, res);
  }

  static async getMessagesByConversation(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { conversationId } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(conversationId)) {
        return Response.responseInvalidInput(res, "Invalid conversation ID");
      }

      const business = await getBusinessForOwner(ownerId);

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
          "You cannot access these messages",
        );
      }

      const messages = await Db.getMessagesByConversation(
        Message,
        conversationId,
      );

      return Response.responseOk(res, messages, "Messages fetched");
    } catch (error) {
      console.error("Error in getMessagesByConversation:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMessageById(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid message ID");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const message = await Db.getMessageById(Message, id);

      if (!message) {
        return Response.responseInvalidInput(res, "Message not found");
      }

      if (String(message.business) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot access this message");
      }

      return Response.responseOk(res, message, "Message fetched");
    } catch (error) {
      console.error("Error in getMessageById:", error);
      return Response.responseServerError(res);
    }
  }

  static async deleteMessage(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid message ID");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const message = await Db.getMessageById(Message, id);

      if (!message) {
        return Response.responseInvalidInput(res, "Message not found");
      }

      if (String(message.business) !== String(business._id)) {
        return Response.responseBadAuth(res, "You cannot delete this message");
      }

      await deleteMessageForBusiness(id, business._id);

      SocketService.emitToBusiness(business._id, "message:deleted", {
        messageId: id,
        conversationId:
          message.conversation?._id?.toString() ||
          message.conversation?.toString() ||
          null,
        deletedAt: new Date().toISOString(),
      });

      SocketService.emitDashboardRefresh(business._id, "message_deleted");

      return res.status(200).json({
        success: true,
        message: "Message deleted successfully",
      });
    } catch (error) {
      console.error("Error in deleteMessage:", error);
      return Response.responseServerError(res);
    }
  }
}

export default MessageController;