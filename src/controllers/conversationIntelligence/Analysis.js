import { Business, Conversation, ConversationIntelligence, ConversationIntelligenceService, Db, Lead, Response, SocketService, analysisIdentity, analysisUpdate, analyzeConversationSchema, beginValuation, claimAnalysis, finishValuation, getMessagesForAnalysis, mongoose, safeConsole, updateAnalyzedLead } from './context.js';

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
          "You cannot analyze this conversation",
        );
      }

      const lead = conversation.lead
        ? await Db.getLeadById(Lead, conversation.lead._id || conversation.lead)
        : null;

      const messages = await getMessagesForAnalysis(conversationId);

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
        const analysisLead = lead ? await Db.getLeadById(Lead, lead._id) : null;
        const analysis = await ConversationIntelligenceService.analyze({
          business,
          conversation,
          lead: analysisLead,
          messages,
        });

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
      safeConsole.error("Error in analyzeConversation:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
  }
}
