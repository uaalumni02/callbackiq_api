
import mongoose from "mongoose";

import DemoRequest from "../../models/demoRequest.js";


import * as Response from "../../helpers/response/response.js";
import DemoSchedulingService from "../../services/demoScheduling.service.js";

import SocketService from "../../services/socket.service.js";

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

export { emitAdminRefresh, publicDemo, bookingError, requireBookingAccess, escapeIcs, toIcsUtc };
