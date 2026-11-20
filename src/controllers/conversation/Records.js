import { Conversation, Db, Response, SocketService, assertTenantReferences, conversationUpdateValidator, conversationValidator, createOrReuseConversation, emitConversationUpdated, getBusinessForOwner, getConversationsPage, queryFailure, safeConsole, setPaginationHeaders, withConversationPermissions } from './context.js';
import ConversationAccessController from './Access.js';

export default class ConversationRecordsController {
static async createConversation(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const validatedBody = await conversationValidator.validateAsync(req.body);

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      await assertTenantReferences(business._id, validatedBody);
      const conversation = await createOrReuseConversation({
        businessId: business._id,
        payload: validatedBody,
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
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
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

      const page = await getConversationsPage(business._id, req.query);
      const pagination = setPaginationHeaders(res, page);
      const payload = page.items.map((conversation) =>
        withConversationPermissions(conversation, true),
      );

      return Response.responseOk(res, payload, "Conversations fetched", pagination);
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in getMyConversations:", error);
      return Response.responseServerError(res);
    }
  }

static async getConversationById(req, res) {
    try {
      const access = await ConversationAccessController.getAuthorizedConversation(
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
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in getConversationById:", error);
      return Response.responseServerError(res);
    }
  }

static async updateConversation(req, res) {
    try {
      const access = await ConversationAccessController.getAuthorizedConversation(
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

      const updates = await conversationUpdateValidator.validateAsync(req.body);
      if (updates.business && String(updates.business) !== String(access.businessId)) {
        return Response.responseInvalidInput(res, 'Business ownership cannot be changed');
      }
      delete updates.business;
      await assertTenantReferences(access.businessId, updates);
      const updatedConversation = await Db.updateConversationForBusiness(
        Conversation, req.params.id, access.businessId, { $set: updates },
      );
      if (!updatedConversation) return Response.responseInvalidInput(res, "Conversation not found");

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
      if (error.isJoi) return Response.responseInvalidInput(res, error.message);
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in updateConversation:", error);
      return Response.responseServerError(res);
    }
  }
}
