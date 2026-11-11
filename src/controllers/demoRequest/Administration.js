import { Db, DemoNotificationService, DemoRequest, DemoSchedulingService, Response, bookingError, emitAdminRefresh, isAdminUser, mongoose, safeConsole, updateDemoRequestSchema } from './context.js';

export default class DemoRequestAdministrationController {
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
      safeConsole.error("Error in getDemoRequests:", error);
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
      safeConsole.error("Error in getDemoRequestById:", error);
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

      safeConsole.error("Error in updateDemoRequest:", error);
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
      safeConsole.error("Error in deleteDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }
}
