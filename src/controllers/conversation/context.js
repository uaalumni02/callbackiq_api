import { queryFailure } from "../../services/scale/queryBudget.js";

import { safeConsole } from "../../helpers/logging/safeLogger.js";

import mongoose from "mongoose";

import Db from "../../db/db.js";

import Business from "../../models/business.js";

import Conversation from "../../models/conversation.js";

import Message from "../../models/message.js";

import conversationValidator from "../../validator/conversation.js";

import conversationUpdateValidator from "../../validator/conversationUpdate.js";

import { assertTenantReferences } from "../../services/tenantReferences.service.js";

import * as Response from "../../helpers/response/response.js";

import SocketService from "../../services/socket.service.js";

import { normalizePhoneToE164, phoneLookupVariants } from "../../voice/voicePhone.service.js";

import { isCurrentAdminRequest } from "../../helpers/security/current-admin.js";

import { getConversationsPage, setPaginationHeaders } from "../../services/cursorPagination.service.js";

const getBusinessForOwner = async (ownerId) => {
  return typeof Db.getBusinessScopeByOwner === "function"
    ? Db.getBusinessScopeByOwner(Business, ownerId)
    : Db.getBusinessByOwner(Business, ownerId);
};

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

export { Conversation, Db, Response, getBusinessForOwner, getReferenceId, isCurrentAdminRequest, mongoose, SocketService, assertTenantReferences, conversationValidator, createOrReuseConversation, queryFailure, safeConsole, withConversationPermissions, getConversationsPage, setPaginationHeaders, conversationUpdateValidator, emitConversationUpdated, Message, deleteOptionalConversationRecords };
