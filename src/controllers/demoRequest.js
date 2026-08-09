import mongoose from "mongoose";

import Db from "../db/db.js";
import DemoRequest from "../models/demoRequest.js";
import {
  demoRequestSchema,
  publicDemoScheduleSchema,
  publicDemoTokenSchema,
  updateDemoRequestSchema,
} from "../validator/demoRequest.js";
import { isAdminUser } from "../helpers/model/admin.js";
import * as Response from "../helpers/response/response.js";
import DemoSchedulingService from "../services/demoScheduling.service.js";
import DemoNotificationService from "../services/demoNotification.service.js";
import SocketService from "../services/socket.service.js";

const publicDemo = (demo) => {
  const source =
    typeof demo?.toObject === "function" ? demo.toObject() : { ...(demo || {}) };

  delete source.bookingTokenHash;
  delete source.adminNotes;
  delete source.slotKey;
  delete source.convertedBusiness;

  return {
    _id: source._id,
    fullName: source.fullName,
    email: source.email,
    phone: source.phone,
    businessName: source.businessName,
    businessType: source.businessType,
    website: source.website,
    preferredTime: source.preferredTime,
    visitorTimezone: source.visitorTimezone,
    source: source.source,
    utmSource: source.utmSource,
    utmMedium: source.utmMedium,
    utmCampaign: source.utmCampaign,
    utmContent: source.utmContent,
    referrer: source.referrer,
    monthlyCallVolume: source.monthlyCallVolume,
    message: source.message,
    status: source.status,
    scheduledAt: source.scheduledAt,
    scheduledEndAt: source.scheduledEndAt,
    timezone: source.timezone,
    meetingUrl: source.meetingUrl,
    createdAt: source.createdAt,
  };
};

const emitAdminRefresh = (reason, demo) => {
  SocketService.emitToAdmins("admin:dashboard:refresh", {
    reason,
    demoRequestId: demo?._id ? String(demo._id) : null,
    occurredAt: new Date().toISOString(),
  });
};

const bookingError = (res, error) => {
  if (error?.code === "DEMO_SLOT_TAKEN" || error?.code === 11000) {
    return res.status(409).json({
      success: false,
      message:
        error?.code === "DEMO_SLOT_TAKEN"
          ? error.message
          : "That demo time was just booked. Please choose another time.",
    });
  }

  if (error?.code === "DEMO_SLOT_INVALID") {
    return Response.responseInvalidInput(res, error.message);
  }

  return null;
};

const requireBookingAccess = async (id, token) => {
  if (!mongoose.isValidObjectId(id)) return null;

  const demo = await DemoRequest.findById(id).select("+bookingTokenHash");
  if (!demo) return null;

  return DemoSchedulingService.isBookingTokenValid(demo, token) ? demo : null;
};

const escapeIcs = (value = "") =>
  String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");

const toIcsUtc = (date) =>
  new Date(date)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

class DemoRequestController {
  static async createDemoRequest(req, res) {
    try {
      const payload = await demoRequestSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      // Quietly absorb obvious bot submissions so the endpoint does not become
      // an oracle for automated form spam.
      if (payload.faxNumber) {
        return res.status(201).json({
          success: true,
          message: "Demo request submitted successfully.",
          data: null,
        });
      }

      delete payload.faxNumber;

      const bookingToken = DemoSchedulingService.createBookingToken();
      const demoRequest = await Db.saveDemoRequest(DemoRequest, {
        ...payload,
        source: payload.source || "website",
        bookingTokenHash:
          DemoSchedulingService.hashBookingToken(bookingToken),
      });

      emitAdminRefresh("demo_request_created", demoRequest);
      await DemoNotificationService.notifyAdminNewRequest(demoRequest);

      const publicRequest = publicDemo(demoRequest);

      return res.status(201).json({
        success: true,
        message: "Demo request created. Choose an available time to book it.",
        // Keep the legacy flattened fields for API compatibility while the
        // booking UI uses data.request + data.bookingToken.
        data: {
          ...publicRequest,
          request: publicRequest,
          bookingToken,
        },
      });
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in createDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }

  static async getAvailability(req, res) {
    try {
      const data = await DemoSchedulingService.getDemoAvailability(DemoRequest);
      return Response.responseOk(
        res,
        data,
        "Demo availability fetched successfully.",
      );
    } catch (error) {
      console.error("Error in getDemoAvailability:", error);
      return Response.responseServerError(res);
    }
  }

  static async getPublicDemoRequest(req, res) {
    try {
      const { token } = await publicDemoTokenSchema.validateAsync(req.query, {
        abortEarly: false,
        stripUnknown: true,
      });

      const demo = await requireBookingAccess(req.params.id, token);
      if (!demo) {
        return res.status(404).json({
          success: false,
          message: "Demo booking not found or the access link is invalid.",
        });
      }

      return Response.responseOk(
        res,
        publicDemo(demo),
        "Demo booking fetched successfully.",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in getPublicDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }

  static async scheduleDemoRequest(req, res) {
    try {
      const payload = await publicDemoScheduleSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      const demo = await requireBookingAccess(req.params.id, payload.token);
      if (!demo) {
        return res.status(404).json({
          success: false,
          message: "Demo request not found or the booking token is invalid.",
        });
      }

      if (!["new", "contacted", "cancelled"].includes(demo.status)) {
        return Response.responseInvalidInput(
          res,
          "This demo request cannot be scheduled from its current status.",
        );
      }

      const scheduleUpdate =
        await DemoSchedulingService.assertDemoSlotAvailable(
          DemoRequest,
          payload.scheduledAt,
          { excludeDemoId: demo._id },
        );

      const updated = await DemoRequest.findByIdAndUpdate(
        demo._id,
        scheduleUpdate,
        {
          returnDocument: "after",
          runValidators: true,
        },
      );

      emitAdminRefresh("demo_scheduled", updated);
      await DemoNotificationService.notifyScheduled(updated, payload.token);

      return Response.responseOk(
        res,
        publicDemo(updated),
        "Your CallBackIQ demo is booked.",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      const handled = bookingError(res, error);
      if (handled) return handled;

      console.error("Error in scheduleDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }

  static async rescheduleDemoRequest(req, res) {
    try {
      const payload = await publicDemoScheduleSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      const demo = await requireBookingAccess(req.params.id, payload.token);
      if (!demo) {
        return res.status(404).json({
          success: false,
          message: "Demo booking not found or the booking token is invalid.",
        });
      }

      if (!["scheduled", "cancelled"].includes(demo.status)) {
        return Response.responseInvalidInput(
          res,
          "This demo request cannot be rescheduled from its current status.",
        );
      }

      const scheduleUpdate =
        await DemoSchedulingService.assertDemoSlotAvailable(
          DemoRequest,
          payload.scheduledAt,
          { excludeDemoId: demo._id },
        );

      const updated = await DemoRequest.findByIdAndUpdate(
        demo._id,
        scheduleUpdate,
        {
          returnDocument: "after",
          runValidators: true,
        },
      );

      emitAdminRefresh("demo_rescheduled", updated);
      await DemoNotificationService.notifyScheduled(updated, payload.token);

      return Response.responseOk(
        res,
        publicDemo(updated),
        "Your CallBackIQ demo was rescheduled.",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      const handled = bookingError(res, error);
      if (handled) return handled;

      console.error("Error in rescheduleDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }

  static async cancelDemoRequest(req, res) {
    try {
      const payload = await publicDemoTokenSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      const demo = await requireBookingAccess(req.params.id, payload.token);
      if (!demo) {
        return res.status(404).json({
          success: false,
          message: "Demo booking not found or the booking token is invalid.",
        });
      }

      if (demo.status !== "scheduled") {
        return Response.responseInvalidInput(
          res,
          "Only a scheduled demo can be cancelled.",
        );
      }

      const updated = await DemoRequest.findByIdAndUpdate(
        demo._id,
        {
          status: "cancelled",
          cancelledAt: new Date(),
          slotKey: null,
        },
        {
          returnDocument: "after",
          runValidators: true,
        },
      );

      emitAdminRefresh("demo_cancelled", updated);
      await DemoNotificationService.notifyCancelled(updated);

      return Response.responseOk(
        res,
        publicDemo(updated),
        "Your CallBackIQ demo was cancelled.",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in cancelDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }

  static async getCalendarFile(req, res) {
    try {
      const { token } = await publicDemoTokenSchema.validateAsync(req.query, {
        abortEarly: false,
        stripUnknown: true,
      });

      const demo = await requireBookingAccess(req.params.id, token);
      if (!demo || !demo.scheduledAt || !demo.scheduledEndAt) {
        return res.status(404).json({
          success: false,
          message: "Scheduled demo not found or the access link is invalid.",
        });
      }

      const description = [
        "CallBackIQ product demo",
        demo.meetingUrl ? `Join: ${demo.meetingUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const calendar = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//CallBackIQ//Book a Demo//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${escapeIcs(String(demo._id))}@callbackiq.com`,
        `DTSTAMP:${toIcsUtc(new Date())}`,
        `DTSTART:${toIcsUtc(demo.scheduledAt)}`,
        `DTEND:${toIcsUtc(demo.scheduledEndAt)}`,
        `SUMMARY:${escapeIcs("CallBackIQ Demo")}`,
        `DESCRIPTION:${escapeIcs(description)}`,
        ...(demo.meetingUrl
          ? [`LOCATION:${escapeIcs(demo.meetingUrl)}`]
          : []),
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n");

      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="callbackiq-demo.ics"',
      );
      return res.status(200).send(calendar);
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      console.error("Error in getCalendarFile:", error);
      return Response.responseServerError(res);
    }
  }

  static async getDemoRequests(req, res) {
    try {
      if (!isAdminUser(req.user)) {
        return Response.responseBadAuth(res, "Admin access required");
      }

      const status = String(req.query?.status || "").trim();
      const filter = status ? { status } : {};

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

      const current = await Db.getDemoRequestById(DemoRequest, id);
      if (!current) {
        return Response.responseInvalidInput(res, "Demo request not found.");
      }

      if (payload.convertedBusiness === "") {
        payload.convertedBusiness = null;
      }

      let newBookingToken = null;
      let scheduledChanged = false;

      if (payload.scheduledAt) {
        const requestedTimezone = payload.timezone;
        const requestedMeetingUrl = payload.meetingUrl;
        const scheduleUpdate =
          await DemoSchedulingService.assertDemoSlotAvailable(
            DemoRequest,
            payload.scheduledAt,
            { excludeDemoId: id },
          );

        Object.assign(payload, scheduleUpdate);

        // The slot itself uses the configured sales-calendar timezone, but keep
        // explicit admin presentation/meeting data instead of overwriting it.
        if (requestedTimezone) payload.timezone = requestedTimezone;
        if (requestedMeetingUrl !== undefined) {
          payload.meetingUrl = requestedMeetingUrl;
        }

        newBookingToken = DemoSchedulingService.createBookingToken();
        payload.bookingTokenHash =
          DemoSchedulingService.hashBookingToken(newBookingToken);
        scheduledChanged = true;
      } else if (payload.scheduledAt === null) {
        if (payload.status === "scheduled") {
          return Response.responseInvalidInput(
            res,
            "A scheduled demo requires a scheduled date and time.",
          );
        }

        payload.scheduledAt = null;
        payload.scheduledEndAt = null;
        payload.slotKey = null;
      }

      if (payload.status === "scheduled" && !payload.scheduledAt) {
        if (!current.scheduledAt) {
          return Response.responseInvalidInput(
            res,
            "A scheduled demo requires a scheduled date and time.",
          );
        }

        // Saving notes on an already scheduled demo must not reclaim the slot,
        // rotate its management token, or send another confirmation email. Only
        // a legacy/previously-cancelled record needs its stored time reclaimed.
        if (current.status !== "scheduled" || !current.slotKey) {
          const requestedTimezone = payload.timezone || current.timezone;
          const requestedMeetingUrl =
            payload.meetingUrl !== undefined
              ? payload.meetingUrl
              : current.meetingUrl;
          const scheduleUpdate =
            await DemoSchedulingService.assertDemoSlotAvailable(
              DemoRequest,
              current.scheduledAt,
              { excludeDemoId: id },
            );

          Object.assign(payload, scheduleUpdate);
          if (requestedTimezone) payload.timezone = requestedTimezone;
          if (requestedMeetingUrl !== undefined) {
            payload.meetingUrl = requestedMeetingUrl;
          }

          newBookingToken = DemoSchedulingService.createBookingToken();
          payload.bookingTokenHash =
            DemoSchedulingService.hashBookingToken(newBookingToken);
          scheduledChanged = true;
        }
      }

      if (payload.status === "contacted" && !current.contactedAt) {
        payload.contactedAt = new Date();
      }

      if (payload.status === "completed" && !current.completedAt) {
        payload.completedAt = new Date();
      }

      if (payload.status === "converted" && !current.convertedAt) {
        payload.convertedAt = new Date();
      }

      if (payload.status === "cancelled") {
        payload.cancelledAt = current.cancelledAt || new Date();
      }

      if (payload.status && payload.status !== "scheduled") {
        payload.slotKey = null;
      }

      const demoRequest = await Db.updateDemoRequest(DemoRequest, id, payload);

      emitAdminRefresh("demo_request_updated", demoRequest);

      if (demoRequest?.status === "scheduled" && scheduledChanged) {
        await DemoNotificationService.notifyScheduled(
          demoRequest,
          newBookingToken,
        );
      } else if (payload.status === "cancelled") {
        await DemoNotificationService.notifyCancelled(demoRequest);
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

      const handled = bookingError(res, error);
      if (handled) return handled;

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

      emitAdminRefresh("demo_request_deleted", demoRequest);

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
