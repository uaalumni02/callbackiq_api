import { Business, ConversationIntelligence, Db, Response, listQuerySchema, mongoose, opportunityQuerySchema, safeConsole } from './context.js';

export default class ConversationIntelligenceReadsController {
static async getMyConversationIntelligence(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const filters = await listQuerySchema.validateAsync(req.query, {
        convert: true,
      });

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const result = await Db.getConversationIntelligenceByBusiness(
        ConversationIntelligence,
        business._id,
        filters,
      );

      return Response.responseOk(
        res,
        result,
        "Conversation intelligence fetched",
      );
    } catch (error) {
      safeConsole.error("Error in getMyConversationIntelligence:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
  }

static async getConversationIntelligence(req, res) {
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

      const intelligence = await Db.getConversationIntelligenceByConversation(
        ConversationIntelligence,
        conversationId,
      );

      if (!intelligence) {
        return Response.responseInvalidInput(
          res,
          "Conversation intelligence not found",
        );
      }

      if (String(intelligence.business) !== String(business._id)) {
        return Response.responseBadAuth(
          res,
          "You cannot access this conversation intelligence",
        );
      }

      return Response.responseOk(
        res,
        intelligence,
        "Conversation intelligence fetched",
      );
    } catch (error) {
      safeConsole.error("Error in getConversationIntelligence:", error);

      return Response.responseServerError(res);
    }
  }

static async getOpportunities(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const validatedQuery = await opportunityQuerySchema.validateAsync(
        req.query,
        {
          convert: true,
        },
      );

      const filters = {
        ...validatedQuery,
        urgency: validatedQuery.urgency
          ? validatedQuery.urgency.split(",")
          : undefined,
      };

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const result = await Db.getConversationIntelligenceOpportunities(
        ConversationIntelligence,
        business._id,
        filters,
      );

      return Response.responseOk(res, result, "AI opportunities fetched");
    } catch (error) {
      safeConsole.error("Error in getOpportunities:", error);

      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      return Response.responseServerError(res);
    }
  }

static async getDashboard(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await Db.getBusinessByOwner(Business, ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const dashboard = await Db.getConversationIntelligenceDashboard(
        ConversationIntelligence,
        business._id,
      );

      return Response.responseOk(
        res,
        dashboard,
        "Conversation intelligence dashboard fetched",
      );
    } catch (error) {
      safeConsole.error("Error in getDashboard:", error);

      return Response.responseServerError(res);
    }
  }
}
