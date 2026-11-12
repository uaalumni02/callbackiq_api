import {readTenantResource} from './shared/tenantResource.js';
import { queryFailure } from "../services/scale/queryBudget.js";
import { safeConsole } from "../helpers/logging/safeLogger.js";
import mongoose from "mongoose";

import Db from "../db/db.js";
import Business from "../models/business.js";
import CallLog from "../models/callLog.js";
import callLogValidator, { callLogUpdateSchema } from "../validator/callLog.js";
import { assertTenantReferences } from "../services/tenantReferences.service.js";
import * as Response from "../helpers/response/response.js";
import SocketService from "../services/socket.service.js";
import {
  getCallLogsOverview,
  getCallLogsPage,
  setPaginationHeaders,
} from "../services/cursorPagination.service.js";

const getBusinessForOwner = async (ownerId) => {
  return typeof Db.getBusinessScopeByOwner === "function"
    ? Db.getBusinessScopeByOwner(Business, ownerId)
    : Db.getBusinessByOwner(Business, ownerId);
};

const updateCallLogForBusiness = (id,businessId,data) => Db.updateCallLogForBusiness(CallLog,id,businessId,data);




class CallLogController {
  static async createCallLog(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const validatedBody = await callLogValidator.validateAsync(req.body);

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      await assertTenantReferences(business._id, validatedBody);
      const callLog = await Db.saveCallLog(CallLog, {
        ...validatedBody,
        business: business._id,
      }, business._id);

      return res.status(201).json({
        success: true,
        message: "Call log created successfully",
        data: callLog,
      });
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Error in createCallLog:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMyCallLogs(req, res) {
    try {
      const ownerId = req.user?.userId;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const page = await getCallLogsPage(business._id, req.query);
      setPaginationHeaders(res, page);
      return Response.responseOk(res, page.items, "Call logs fetched");
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in getMyCallLogs:", error);
      return Response.responseServerError(res);
    }
  }

  static async getMyCallLogsOverview(req, res) {
    try {
      const ownerId = req.user?.userId;
      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      const business = await getBusinessForOwner(ownerId);
      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const data = await getCallLogsOverview(business._id, req.query);
      return Response.responseOk(res, data, "Call log page fetched");
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in getMyCallLogsOverview:", error);
      if (error?.code === "INVALID_CURSOR") {
        return Response.responseInvalidInput(res, "Invalid pagination cursor");
      }
      return Response.responseServerError(res);
    }
  }

  static async getCallLogById(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid call log ID");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const callLog=await readTenantResource({model:CallLog,businessId:business._id,id:id,res,
        missingMessage:"Call log not found",deniedMessage:"You cannot access this call log"});
      if(!callLog)return undefined;

      return Response.responseOk(res, callLog, "Call log fetched");
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in getCallLogById:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateCallLog(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid call log ID");
      }

      const validatedBody = await callLogUpdateSchema.validateAsync(req.body);

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const callLog=await readTenantResource({model:CallLog,businessId:business._id,id:id,res,
        missingMessage:"Call log not found",deniedMessage:"You cannot update this call log"});
      if(!callLog)return undefined;

      if (validatedBody.business && String(validatedBody.business) !== String(business._id)) {
        return Response.responseInvalidInput(res, "Business ownership cannot be changed");
      }
      delete validatedBody.business;
      await assertTenantReferences(business._id, validatedBody);
      const updatedCallLog = await updateCallLogForBusiness(id, business._id, { $set: validatedBody });

      if (!updatedCallLog) {
        return Response.responseInvalidInput(res, "Call log not found");
      }

      return Response.responseOk(
        res,
        updatedCallLog,
        "Call log updated successfully",
      );
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Error in updateCallLog:", error);
      return Response.responseServerError(res);
    }
  }

  static async deleteCallLog(req, res) {
    try {
      const ownerId = req.user?.userId;
      const { id } = req.params;

      if (!ownerId) {
        return Response.responseBadAuth(res, "Not authenticated");
      }

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid call log ID");
      }

      const business = await getBusinessForOwner(ownerId);

      if (!business) {
        return Response.responseInvalidInput(res, "Business not found");
      }

      const callLog=await readTenantResource({model:CallLog,businessId:business._id,id:id,res,
        missingMessage:"Call log not found",deniedMessage:"You cannot delete this call log"});
      if(!callLog)return undefined;

      // CALLBACKIQ_ATTRIBUTION_10OF10_FULL_V2:
      // Hide the operational record without destroying attribution history.
      const deleted = await CallLog.findOneAndUpdate(
        { _id: id, business: business._id, deletedAt: null },
        {
          $set: {
            deletedAt: new Date(),
            deletedBy: ownerId,
            deletionReason: "Deleted from Call Activity",
          },
        },
        { returnDocument: "after" },
      );

      if (!deleted) {
        return Response.responseInvalidInput(res, "Call log not found");
      }

      SocketService.emitToBusiness(business._id, "call:deleted", {
        callId: id,
        deletedAt: deleted.deletedAt,
      });
      SocketService.emitDashboardRefresh(business._id, "call_log_hidden");

      return res.status(200).json({
        success: true,
        message: "Call log hidden successfully",
      });
    } catch (error) {
      if (queryFailure(error)) return res.status(503).set("Retry-After", "2").json({ success: false, code: "QUERY_BUDGET_EXCEEDED", message: "This view is busy. Please retry or narrow your search." });
      safeConsole.error("Error in deleteCallLog:", error);
      return Response.responseServerError(res);
    }
  }
}

export default CallLogController;
