import {tenantRepository,tenantContext} from '../../db/repositories/tenantRepository.js';
import { Conversation, Db, Message, Response, SocketService, deleteOptionalConversationRecords, emitConversationUpdated, queryFailure, safeConsole, withConversationPermissions } from './context.js';
import ConversationAccessController from './Access.js';

export default class ConversationLifecycleController {
static async archiveConversation(req, res) {
    try {
      const access = await ConversationAccessController.getAuthorizedConversation(
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

      const updatedConversation = await Db.updateConversationForBusiness(
        Conversation,
        req.params.id,
        access.businessId,
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
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in archiveConversation:", error);
      return Response.responseServerError(res);
    }
  }

static async restoreConversation(req, res) {
    try {
      const access = await ConversationAccessController.getAuthorizedConversation(
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

      const updatedConversation = await Db.updateConversationForBusiness(
        Conversation,
        req.params.id,
        access.businessId,
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
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in restoreConversation:", error);
      return Response.responseServerError(res);
    }
  }

static async deleteConversation(req, res) {
    try {
      const access = await ConversationAccessController.getAuthorizedConversation(
        req,
        res,
        "You cannot delete this conversation",
      );

      if (!access) return undefined;

      await Promise.all([
        tenantRepository(Message,tenantContext(access.businessId)).removeManyByReference('conversation',req.params.id),
        deleteOptionalConversationRecords(
          "ConversationIntelligence",
          req.params.id,
          access.businessId,
        ),
        deleteOptionalConversationRecords("Alert",req.params.id,access.businessId),
      ]);

      await Db.deleteConversationForBusiness(Conversation,req.params.id,access.businessId);

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
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in deleteConversation:", error);
      return Response.responseServerError(res);
    }
  }
}
