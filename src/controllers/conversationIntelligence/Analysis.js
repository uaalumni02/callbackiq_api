import {tenantRepository,tenantContext} from '../../db/repositories/tenantRepository.js';
import { runAiUsageOperation } from '../../services/aiUsageOperation.service.js';
import {readTenantResource} from '../shared/tenantResource.js';
import Business from "../../models/business.js";
import Conversation from "../../models/conversation.js";
import ConversationIntelligence from "../../models/conversationIntelligence.js";
import ConversationIntelligenceService from "../../services/conversationIntelligence.service.js";
import Db from "../../db/db.js";
import Lead from "../../models/lead.js";
import * as Response from "../../helpers/response/response.js";
import SocketService from "../../services/socket.service.js";
import { analysisIdentity, analysisUpdate, claimAnalysis, updateAnalyzedLead } from "../../services/conversationIntelligence.persistence.js";
import { analyzeConversationSchema } from "../../validator/conversationIntelligence.js";
import { beginValuation, finishValuation } from "../../services/valuation/opportunityValuation.service.js";
import { getMessagesForAnalysis } from "./helpers.js";
import mongoose from "mongoose";
import { safeConsole } from "../../helpers/logging/safeLogger.js";
export default class ConversationIntelligenceAnalysisController {
static async analyzeConversation(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { conversationId } = req.params;
      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }
      if (!mongoose.isValidObjectId(conversationId)) {
        return Response.responseInvalidInput(res, "Invalid conversation ID");
      }

      await analyzeConversationSchema.validateAsync(
        req.body || {},
      );

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const conversation=await readTenantResource({model:Conversation,businessId:business._id,id:conversationId,res,
        missingMessage:"Conversation not found",deniedMessage:"You cannot analyze this conversation"});
      if(!conversation)return undefined;

      const lead = conversation.lead
        ? await tenantRepository(Lead,tenantContext(business._id)).read(conversation.lead._id || conversation.lead)
        : null;

      const messages = await getMessagesForAnalysis(conversationId,business._id);

      if (!messages?.length) {
        return Response.responseInvalidInput(
          res,
          "Conversation does not contain any messages",
        );
      }

      const claim = await claimAnalysis({ businessId: business._id,
        conversationId: conversation._id, leadId: lead?._id });
      if (!claim) return Response.responseInvalidInput(res, "Conversation analysis is already in progress");

      try {
        const valuationTicket = await beginValuation(lead, business._id);
        // Reservation itself changes updatedAt. Read a fresh snapshot for guarded lead writes.
        const analysisLead = lead ? await tenantRepository(Lead,tenantContext(business._id)).read(lead._id) : null;
        const analysis = await runAiUsageOperation({ business, customerPhone: conversation.customerPhone, source: 'owner_conversation_analysis' }, () => ConversationIntelligenceService.analyze({
          business,
          conversation,
          lead: analysisLead,
          messages,
        }));

        const intelligence = await ConversationIntelligence.findOneAndUpdate(
          analysisIdentity(claim),
          { $set: {
            ...analysisUpdate(analysis),
            business: business._id,
            conversation: conversation._id,
            lead: lead?._id || null,
            status: "completed",
            analysisLeaseExpiresAt: null,
            sourceMessageCount: messages.length,
            lastMessageAnalyzedAt:
              messages[messages.length - 1]?.createdAt || new Date(),
            errorMessage: "",
          } }, { returnDocument: "after", runValidators: true },
        );
        if (!intelligence) return Response.responseOk(res, null, "A newer analysis superseded this result");

        try {
          await updateAnalyzedLead({ lead: analysisLead, businessId: business._id, analysis });
        } catch (error) {
          // The analysis is already durable; ancillary failure must not relabel it failed.
          safeConsole.error("conversation_intelligence.lead_update_failed", { code: error.code || error.name });
        }

        await finishValuation(valuationTicket, { businessId: business._id,
          evidence: messages.filter(message => message.direction === "inbound").map(message => message.body).join("\n"),
          proposedService: analysis.customerIntent.serviceType });

        SocketService.emitToBusiness(
          business._id,
          "conversation-intelligence:updated",
          intelligence,
        );

        SocketService.emitDashboardRefresh(
          business._id,
          "conversation_intelligence_updated",
        );

        return Response.responseOk(
          res,
          intelligence,
          "Conversation analyzed successfully",
        );
      } catch (analysisError) {
        await ConversationIntelligence.findOneAndUpdate(
          analysisIdentity(claim),
          {
            status: "failed",
            analysisLeaseExpiresAt: null,
            errorMessage: "Unable to analyze conversation",
          },
        );

        throw analysisError;
      }
    } catch (error) {
      if ([429, 503].includes(error.statusCode)) return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message });
      safeConsole.error("Error in analyzeConversation:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
  }
}
