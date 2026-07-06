import mongoose from "mongoose";

import Db from "../db/db.js";
import DemoRequest from "../models/demoRequest.js";
import {
  demoRequestSchema,
  updateDemoRequestSchema,
} from "../validator/demoRequest.js";
import { isAdminUser } from "../helpers/model/admin.js";
import * as Response from "../helpers/response/response.js";

class DemoRequestController {
  static async createDemoRequest(req, res) {
    try {
      const payload = await demoRequestSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      const demoRequest = await Db.saveDemoRequest(DemoRequest, {
        ...payload,
        source: payload.source || "website",
      });

      return res.status(201).json({
        success: true,
        message: "Demo request submitted successfully.",
        data: demoRequest,
      });
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in createDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }

  static async getDemoRequests(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const { status } = req.query;
      const filter = {};

      if (status) {
        filter.status = status;
      }

      const demoRequests = await Db.getDemoRequests(DemoRequest, filter);

      return Response.responseOk(
        res,
        demoRequests,
        "Demo requests fetched successfully.",
      );
    } catch (error) {
      console.error("Error in getDemoRequests:", error);
      return Response.responseServerError(res);
    }
  }

  static async getDemoRequestById(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid demo request ID.");
      }

      const demoRequest = await Db.getDemoRequestById(DemoRequest, id);

      if (!demoRequest) {
        return Response.responseInvalidInput(res, "Demo request not found.");
      }

      return Response.responseOk(
        res,
        demoRequest,
        "Demo request fetched successfully.",
      );
    } catch (error) {
      console.error("Error in getDemoRequestById:", error);
      return Response.responseServerError(res);
    }
  }

  static async updateDemoRequest(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid demo request ID.");
      }

      const payload = await updateDemoRequestSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      if (Object.keys(payload).length === 0) {
        return Response.responseInvalidInput(
          res,
          "No valid demo request updates provided.",
        );
      }

      if (payload.status === "contacted") {
        payload.contactedAt = new Date();
      }

      const demoRequest = await Db.updateDemoRequest(DemoRequest, id, payload);

      if (!demoRequest) {
        return Response.responseInvalidInput(res, "Demo request not found.");
      }

      return Response.responseOk(
        res,
        demoRequest,
        "Demo request updated successfully.",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in updateDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }

  static async deleteDemoRequest(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        return Response.responseInvalidInput(res, "Invalid demo request ID.");
      }

      const demoRequest = await Db.deleteDemoRequest(DemoRequest, id);

      if (!demoRequest) {
        return Response.responseInvalidInput(res, "Demo request not found.");
      }

      return res.status(200).json({
        success: true,
        message: "Demo request deleted successfully.",
      });
    } catch (error) {
      console.error("Error in deleteDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }
}

export default DemoRequestController;
