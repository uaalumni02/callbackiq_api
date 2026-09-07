import { safeConsole } from "../helpers/logging/safeLogger.js";
import Joi from "joi";

import Db from "../db/db.js";
import DemoRequest from "../models/demoRequest.js";
import { demoRequestSchema } from "../validator/demoRequest.js";
import DemoSchedulingService from "../services/demoScheduling.service.js";
import DemoNotificationService from "../services/demoNotification.service.js";
import SocketService from "../services/socket.service.js";
import * as Response from "../helpers/response/response.js";

const atomicDemoBookingSchema = demoRequestSchema.keys({
  scheduledAt: Joi.date().iso().required(),
});

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

class DemoBookingController {
  static async bookDemoRequest(req, res) {
    try {
      const payload = await atomicDemoBookingSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      // Quietly absorb obvious bot submissions without creating a record,
      // sending email, or revealing the honeypot behavior.
      if (payload.faxNumber) {
        return res.status(201).json({
          success: true,
          message: "Your CallBackIQ demo is booked.",
          data: null,
        });
      }

      const { scheduledAt, faxNumber, ...requestPayload } = payload;
      const scheduleUpdate =
        await DemoSchedulingService.assertDemoSlotAvailable(
          DemoRequest,
          scheduledAt,
        );

      const bookingToken = DemoSchedulingService.createBookingToken();
      const demoRequest = await Db.saveDemoRequest(DemoRequest, {
        ...requestPayload,
        source: requestPayload.source || "book_demo_page",
        ...scheduleUpdate,
        bookingTokenHash:
          DemoSchedulingService.hashBookingToken(bookingToken),
      });

      SocketService.emitToAdmins("admin:dashboard:refresh", {
        reason: "demo_scheduled",
        demoRequestId: demoRequest?._id ? String(demoRequest._id) : null,
        occurredAt: new Date().toISOString(),
      });

      // The notification service is delivery-safe: email failure must not undo
      // an already-confirmed booking.
      await DemoNotificationService.notifyScheduled(
        demoRequest,
        bookingToken,
      );

      return res.status(201).json({
        success: true,
        message: "Your CallBackIQ demo is booked.",
        data: {
          request: publicDemo(demoRequest),
          bookingToken,
        },
      });
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      const handled = bookingError(res, error);
      if (handled) return handled;

      safeConsole.error("Error in bookDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }
}

export { atomicDemoBookingSchema };
export default DemoBookingController;
