import {readTenantResource} from '../shared/tenantResource.js';
import Business from "../../models/business.js";
import ConversationIntelligence from "../../models/conversationIntelligence.js";
import Db from "../../db/db.js";
import * as Response from "../../helpers/response/response.js";
import { listQuerySchema, opportunityQuerySchema } from "../../validator/conversationIntelligence.js";
import mongoose from "mongoose";
import { safeConsole } from "../../helpers/logging/safeLogger.js";

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

      const intelligence=await readTenantResource({model:ConversationIntelligence,businessId:business._id,id:conversationId,res,
        missingMessage:"Conversation intelligence not found",deniedMessage:"You cannot access this conversation intelligence",
        identityField:'conversation'});
      if(!intelligence)return undefined;

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
