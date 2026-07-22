import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import conversationValidator from "../validator/conversation.js";
import * as Response from "../helpers/response/response.js";
import SocketService from "../services/socket.service.js";

const getBusinessForOwner = async (ownerId) => {
  return typeof Db.getBusinessScopeByOwner === "function"
    ? Db.getBusinessScopeByOwner(Business, ownerId)
    : Db.getBusinessByOwner(Business, ownerId);
};

const ADMIN_ROLES = new Set([
  "admin",
  "administrator",
  "superadmin",
  "super_admin",
]);
const PROTECTED_ARCHIVE_FIELDS = new Set([
  "business",
  "archivedAt",
  "archivedBy",
  "archiveSnapshot",
]);

const getAuthenticatedRole = (req) =>
  String(req.user?.role || req.user?.userRole || req.user?.accountType || "")
    .trim()
    .toLowerCase();

const isAdminRequest = (req) =>
  req.user?.isAdmin === true || ADMIN_ROLES.has(getAuthenticatedRole(req));

const getReferenceId = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;

  return String(value._id || value.id || value);
};

const toPlainObject = (value) => {
  if (!value) return value;
  if (typeof value.toObject === "function") return value.toObject();

  return { ...value };
};

const withConversationPermissions = (conversation, canDelete = true) => {
  const plainConversation = toPlainObject(conversation);

  if (!plainConversation) return plainConversation;

  const isArchived = plainConversation.status === "archived";

  return {
    ...plainConversation,
    permissions: {
      ...(plainConversation.permissions || {}),
      canArchive: !isArchived,
      canRestore: isArchived,
      canDelete: Boolean(canDelete),
    },
  };
};

const emitConversationUpdated = (businessId, conversation) => {
  const payload = withConversationPermissions(conversation, true);

  SocketService.emitConversationUpdated(businessId, payload);
  SocketService.emitDashboardRefresh(businessId, "conversation_updated");

  return payload;
};

const deleteOptionalConversationRecords = async (modelName, conversationId) => {
  const model = mongoose.models[modelName];

  if (!model || !model.schema?.path("conversation")) return;

  await model.deleteMany({ conversation: conversationId });
};

class ConversationController {
  static async getAuthorizedConversation(req, res, deniedMessage) {
    const requesterId = req.user?.userId;
    const { id } = req.params;

    if (!requesterId) {
      Response.responseBadAuth(res, "Not authenticated");
      return null;
    }

    if (!mongoose.isValidObjectId(id)) {
      Response.responseInvalidInput(res, "Invalid conversation ID");
      return null;
    }

    const conversation = await Db.getConversationById(Conversation, id);

    if (!conversation) {
      Response.responseInvalidInput(res, "Conversation not found");
      return null;
    }

    const conversationBusinessReference =
      conversation.business?._id || conversation.business;
    const conversationBusinessId = getReferenceId(
      conversationBusinessReference,
    );

    if (isAdminRequest(req)) {
      return {
        requesterId,
        conversation,
        business: null,
        businessId: conversationBusinessReference,
        isAdmin: true,
      };
    }

    const business = await getBusinessForOwner(requesterId);

    if (!business) {
      Response.responseInvalidInput(res, "Business not found");
      return null;
    }

    if (conversationBusinessId !== getReferenceId(business)) {
      Response.responseBadAuth(res, deniedMessage);
      return null;
    }

    return {
      requesterId,
      conversation,
      business,
      businessId: business._id,
      isAdmin: false,
    };
  }

  static async createConversation(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      await conversationValidator.validateAsync(req.body);

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const conversation = await Db.saveConversation(Conversation, {
        ...req.body,
        business: business._id,
      });

      const payload = withConversationPermissions(conversation, true);

      SocketService.emitConversationCreated(business._id, payload);
      SocketService.emitDashboardRefresh(business._id, "conversation_created");

      return res.status(201).json({
        success: true,
        message: "Conversation created successfully",
        data: payload,
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

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const conversations = await Db.getConversationsByBusiness(
        Conversation,
        business._id,
      );

      const payload = conversations.map((conversation) =>
        withConversationPermissions(conversation, true),
      );

      return Response.responseOk(res, payload, "Conversations fetched");
    } catch (error) {
      console.error("Error in getMyConversations:", error);
      return Response.responseServerError(res);
    }
  }

  static async getConversationById(req, res) {
    try {
      const access = await ConversationController.getAuthorizedConversation(
        req,
        res,
        "You cannot access this conversation",
      );

      if (!access) return undefined;

      return Response.responseOk(
        res,
        withConversationPermissions(access.conversation, true),
        "Conversation fetched",
      );
    } catch (error) {
      console.error("Error in getConversationById:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateConversation(req, res) {
    try {
      const access = await ConversationController.getAuthorizedConversation(
        req,
        res,
        "You cannot update this conversation",
      );

      if (!access) return undefined;

      if (req.body?.status === "archived") {
        return Response.responseInvalidInput(
          res,
          "Use the archive conversation endpoint to archive a conversation",
        );
      }

      if (
        access.conversation.status === "archived" &&
        req.body?.status &&
        req.body.status !== "archived"
      ) {
        return Response.responseInvalidInput(
          res,
          "Restore the conversation before changing its status",
        );
      }

      const updates = Object.entries(req.body || {}).reduce(
        (nextUpdates, [key, value]) => {
          if (!PROTECTED_ARCHIVE_FIELDS.has(key)) {
            nextUpdates[key] = value;
          }

          return nextUpdates;
        },
        {},
      );

      if (!Object.keys(updates).length) {
        return Response.responseInvalidInput(
          res,
          "No valid conversation updates were provided",
        );
      }

      const updatedConversation = await Db.updateConversation(
        Conversation,
        req.params.id,
        updates,
      );

      const payload = emitConversationUpdated(
        access.businessId,
        updatedConversation,
      );

      return Response.responseOk(
        res,
        payload,
        "Conversation updated successfully",
      );
    } catch (error) {
      console.error("Error in updateConversation:", error);
      return Response.responseServerError(res);
    }
  }

  static async archiveConversation(req, res) {
    try {
      const access = await ConversationController.getAuthorizedConversation(
        req,
        res,
        "You cannot archive this conversation",
      );

      if (!access) return undefined;

      if (access.conversation.status === "archived") {
        return Response.responseOk(
          res,
          withConversationPermissions(access.conversation, true),
          "Conversation is already archived",
        );
      }

      const currentStatus = ["open", "closed"].includes(
        access.conversation.status,
      )
        ? access.conversation.status
        : "closed";

      const updatedConversation = await Db.updateConversation(
        Conversation,
        req.params.id,
        {
          status: "archived",
          archivedAt: new Date(),
          archivedBy: access.requesterId,
          archiveSnapshot: {
            status: currentStatus,
            aiEnabled: access.conversation.aiEnabled !== false,
            humanTakeover: access.conversation.humanTakeover === true,
          },
          aiEnabled: false,
          humanTakeover: true,
        },
      );

      const payload = emitConversationUpdated(
        access.businessId,
        updatedConversation,
      );

      return Response.responseOk(
        res,
        payload,
        "Conversation archived successfully",
      );
    } catch (error) {
      console.error("Error in archiveConversation:", error);
      return Response.responseServerError(res);
    }
  }

  static async restoreConversation(req, res) {
    try {
      const access = await ConversationController.getAuthorizedConversation(
        req,
        res,
        "You cannot restore this conversation",
      );

      if (!access) return undefined;

      if (access.conversation.status !== "archived") {
        return Response.responseOk(
          res,
          withConversationPermissions(access.conversation, true),
          "Conversation is already active",
        );
      }

      const snapshot = access.conversation.archiveSnapshot;
      const restoredStatus = ["open", "closed"].includes(snapshot?.status)
        ? snapshot.status
        : "closed";
      const restoredAiEnabled =
        typeof snapshot?.aiEnabled === "boolean" ? snapshot.aiEnabled : false;
      const restoredHumanTakeover =
        typeof snapshot?.humanTakeover === "boolean"
          ? snapshot.humanTakeover
          : true;

      const updatedConversation = await Db.updateConversation(
        Conversation,
        req.params.id,
        {
          status: restoredStatus,
          aiEnabled: restoredAiEnabled,
          humanTakeover: restoredHumanTakeover,
          archivedAt: null,
          archivedBy: null,
          archiveSnapshot: null,
        },
      );

      const payload = emitConversationUpdated(
        access.businessId,
        updatedConversation,
      );

      return Response.responseOk(
        res,
        payload,
        "Conversation restored successfully",
      );
    } catch (error) {
      console.error("Error in restoreConversation:", error);
      return Response.responseServerError(res);
    }
  }

  static async deleteConversation(req, res) {
    try {
      const access = await ConversationController.getAuthorizedConversation(
        req,
        res,
        "You cannot delete this conversation",
      );

      if (!access) return undefined;

      await Promise.all([
        Message.deleteMany({ conversation: req.params.id }),
        deleteOptionalConversationRecords(
          "ConversationIntelligence",
          req.params.id,
        ),
        deleteOptionalConversationRecords("Alert", req.params.id),
      ]);

      await Db.deleteConversation(Conversation, req.params.id);

      // Include all common ID shapes so existing and updated socket clients
      // can remove the deleted conversation immediately.
      SocketService.emitToBusiness(access.businessId, "conversation:deleted", {
        _id: req.params.id,
        id: req.params.id,
        conversationId: req.params.id,
        deletedAt: new Date().toISOString(),
      });

      SocketService.emitDashboardRefresh(
        access.businessId,
        "conversation_deleted",
      );

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
