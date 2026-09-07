import { safeConsole } from "../helpers/logging/safeLogger.js";
import { handleConversationManualMessage } from "../services/messaging/manualConversationMessage.service.js";
import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import messageValidator from "../validator/message.js";
import * as Response from "../helpers/response/response.js";
import SocketService from "../services/socket.service.js";

import { getMessagesPage, setPaginationHeaders } from "../services/cursorPagination.service.js";
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
  static async createMessage(req, res, next) {
    return handleConversationManualMessage(req, res, next);
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

      /*
       * checkSubscription has already resolved the authenticated tenant
       * business and attached it to req.business. Reuse it instead of
       * repeating the owner -> Business query for every message read.
       */
      const business =
        req.business ||
        (await getBusinessForOwner(ownerId));

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      /*
       * This authorization lookup does not need a fully populated
       * Conversation. Business/lead/archive documents would immediately be
       * discarded before the actual message query.
       */
      const conversation = await Db.getConversationById(
        Conversation,
        conversationId,
        {
          populateBusiness: false,
          populateLead: false,
          populateArchivedBy: false,
          lean: true,
          select:
            "_id business customerPhone customerName status",
        },
      );

      if (!conversation) {
        return Response.responseInvalidInput(res, "Conversation not found");
      }

      const conversationBusinessId =
        conversation.business?._id ||
        conversation.business;

      if (String(conversationBusinessId) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot access these messages",
        );
      }

      // CALLBACKIQ_MESSAGE_CURSOR_PAGINATION_V1
      const page = await getMessagesPage(
        conversationId,
        req.query,
        { conversation },
      );
      setPaginationHeaders(res, page);
      return Response.responseOk(res, page.items, "Messages fetched");
    } catch (error) {
      safeConsole.error("Error in getMessagesByConversation:", error);
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
      safeConsole.error("Error in getMessageById:", error);
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
      safeConsole.error("Error in deleteMessage:", error);
      return Response.responseServerError(res);
    }
  }
}

export default MessageController;