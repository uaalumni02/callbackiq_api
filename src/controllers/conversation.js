import { safeConsole } from "../helpers/logging/safeLogger.js";
import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import Conversation from "../models/conversation.js";
import Message from "../models/message.js";
import conversationValidator from "../validator/conversation.js";
import * as Response from "../helpers/response/response.js";
import SocketService from "../services/socket.service.js";

import { normalizePhoneToE164, phoneLookupVariants } from "../voice/voicePhone.service.js";
import { isCurrentAdminRequest } from "../helpers/security/current-admin.js";
import { getConversationsPage, setPaginationHeaders } from "../services/cursorPagination.service.js";
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

const createOrReuseConversation = async ({ businessId, payload }) => {
  const normalizedCustomerPhone = normalizePhoneToE164(payload.customerPhone);
  const phoneVariants = normalizedCustomerPhone
    ? phoneLookupVariants(normalizedCustomerPhone)
    : [String(payload.customerPhone || "").trim()].filter(Boolean);

  const findExisting = async () => {
    if (!normalizedCustomerPhone) return null;
    return Conversation.findOne({
      business: businessId,
      status: { $ne: "archived" },
      $or: [
        { customerPhoneLookup: normalizedCustomerPhone },
        { customerPhone: { $in: phoneVariants } },
      ],
    }).sort({ lastMessageAt: -1, createdAt: -1 });
  };

  let existingConversation = await findExisting();
  if (!existingConversation) {
    try {
      return await Db.saveConversation(Conversation, {
        ...payload,
        customerPhone: normalizedCustomerPhone || payload.customerPhone,
        business: businessId,
      });
    } catch (error) {
      if (Number(error?.code) !== 11000) throw error;
      existingConversation = await findExisting();
      if (!existingConversation) throw error;
    }
  }

  const updates = {};
  if (
    existingConversation.status === "closed" &&
    existingConversation.humanTakeover !== true
  ) {
    updates.status = "open";
    updates.aiEnabled = true;
    updates.reopenedAt = new Date();
    updates.reopenReason = "conversation_create_reused";
  }
  if (!existingConversation.lead && payload.lead) updates.lead = payload.lead;
  if (
    payload.customerName &&
    ["", "Customer"].includes(String(existingConversation.customerName || "").trim())
  ) {
    updates.customerName = payload.customerName;
  }

  return Object.keys(updates).length
    ? Db.updateConversation(Conversation, existingConversation._id, updates)
    : existingConversation;
};

class ConversationController {
  static async getAuthorizedConversation(
    req,
    res,
    deniedMessage,
    { readOnly = false } = {},
  ) {
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

    /*
     * Preserve the existing fresh-admin authorization semantics while
     * optimizing only the read/database path in this change.
     */
    const currentAdmin = await isCurrentAdminRequest(req);

    /*
     * For the read-only owner path, Business is already resolved by
     * subscription middleware. Keep lead/archive population for API
     * compatibility, but skip the redundant Business populate.
     *
     * Write/admin paths retain the historical fully-populated behavior.
     */
    const conversation = await Db.getConversationById(
      Conversation,
      id,
      readOnly && !currentAdmin
        ? {
            populateBusiness: false,
            populateLead: true,
            populateArchivedBy: true,
            lean: true,
          }
        : undefined,
    );

    if (!conversation) {
      Response.responseInvalidInput(res, "Conversation not found");
      return null;
    }

    const conversationBusinessReference =
      conversation.business?._id || conversation.business;

    const conversationBusinessId = getReferenceId(
      conversationBusinessReference,
    );

    if (currentAdmin) {
      return {
        requesterId,
        conversation,
        business: null,
        businessId: conversationBusinessReference,
        isAdmin: true,
      };
    }

    const business =
      req.business ||
      (await getBusinessForOwner(requesterId));

    if (!business) {
      Response.responseInvalidInput(res, "Business not found");
      return null;
    }

    if (conversationBusinessId !== getReferenceId(business)) {
      Response.responseBadAuth(res, deniedMessage);
      return null;
    }

    const responseConversation =
      readOnly
        ? {
            ...conversation,
            business: {
              _id: business._id,
              businessName: business.businessName,
              phone: business.phone,
              owner: business.owner,
            },
          }
        : conversation;

    return {
      requesterId,
      conversation: responseConversation,
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

      const conversation = await createOrReuseConversation({
        businessId: business._id,
        payload: req.body,
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

      safeConsole.error("Error in createConversation:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMyConversations(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business =
        req.business ||
        (await getBusinessForOwner(ownerId));

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      // CALLBACKIQ_CONVERSATION_CURSOR_PAGINATION_V1
      const page = await getConversationsPage(business._id, req.query);
      setPaginationHeaders(res, page);
      const payload = page.items.map((conversation) =>
        withConversationPermissions(conversation, true),
      );

      return Response.responseOk(res, payload, "Conversations fetched");
    } catch (error) {
      safeConsole.error("Error in getMyConversations:", error);
      return Response.responseServerError(res);
    }
  }

  static async getConversationById(req, res) {
    try {
      const access = await ConversationController.getAuthorizedConversation(
        req,
        res,
        "You cannot access this conversation",
        { readOnly: true },
      );

      if (!access) return undefined;

      return Response.responseOk(
        res,
        withConversationPermissions(access.conversation, true),
        "Conversation fetched",
      );
    } catch (error) {
      safeConsole.error("Error in getConversationById:", error);
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
      safeConsole.error("Error in updateConversation:", error);
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
      safeConsole.error("Error in archiveConversation:", error);
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
      safeConsole.error("Error in restoreConversation:", error);
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
      safeConsole.error("Error in deleteConversation:", error);
      return Response.responseServerError(res);
    }
  }
}

export default ConversationController;
