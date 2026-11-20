import { DemoNotificationService, DemoRequest, DemoSchedulingService, Response, bookingError, emitAdminRefresh, escapeIcs, publicDemo, publicDemoScheduleSchema, publicDemoTokenSchema, requireBookingAccess, safeConsole, toIcsUtc } from './context.js';

export default class DemoRequestBookingController {
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
        "Your MeekCall demo is booked.",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      const handled = bookingError(res, error);
      if (handled) return handled;

      safeConsole.error("Error in scheduleDemoRequest:", error);
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
        "Your MeekCall demo was rescheduled.",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      const handled = bookingError(res, error);
      if (handled) return handled;

      safeConsole.error("Error in rescheduleDemoRequest:", error);
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
        "Your MeekCall demo was cancelled.",
      );
    } catch (error) {
      if (error.isJoi) {
        return Response.responseInvalidInput(res, error.message);
      }

      safeConsole.error("Error in cancelDemoRequest:", error);
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
        "MeekCall product demo",
        demo.meetingUrl ? `Join: ${demo.meetingUrl}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const calendar = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//MeekCall//Book a Demo//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${escapeIcs(String(demo._id))}@callbackiq.com`,
        `DTSTAMP:${toIcsUtc(new Date())}`,
        `DTSTART:${toIcsUtc(demo.scheduledAt)}`,
        `DTEND:${toIcsUtc(demo.scheduledEndAt)}`,
        `SUMMARY:${escapeIcs("MeekCall Demo")}`,
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

      safeConsole.error("Error in getCalendarFile:", error);
      return Response.responseServerError(res);
    }
  }
}
