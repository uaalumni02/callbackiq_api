import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import messageValidator from "../validator/message.js";
import * as Response from "../helpers/response/response.js";

class MessageController {
  static async createMessage(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await messageValidator.validateAsync(req.body);

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const conversation = await Db.getConversationById(
        Conversation,
        req.body.conversation,
      );

      if (!conversation) {
        return Response.responseInvalidInput(res, "Conversation not found");
      }

      if (String(conversation.business._id) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot message this conversation",
        );
      }

      const message = await Db.saveMessage(Message, {
        ...req.body,
        business: business._id,
      });

      await Db.updateConversation(Conversation, conversation._id, {
        lastMessage: req.body.body,
        lastMessageAt: new Date(),
      });

      return res.status(201).json({
        success: true,
        message: "Message created successfully",
        data: message,
      });
    } catch (error) {
      console.error("Error in createMessage:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
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

      const business = await Db.getBusinessByOwner(Business, ownerId);

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

      const business = await Db.getBusinessByOwner(Business, ownerId);

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

      await Db.deleteMessage(Message, id);

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
