import { Db, DemoNotificationService, DemoRequest, DemoSchedulingService, Response, bookingError, demoRequestSchema, emitAdminRefresh, publicDemo, publicDemoBookingSchema, publicDemoTokenSchema, requireBookingAccess, safeConsole } from './context.js';

export default class DemoRequestPublicController {
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

      safeConsole.error("Error in createDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }

static async bookDemoRequest(req, res) {
    try {
      const payload = await publicDemoBookingSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });

      // Honeypot submissions receive a generic success response but are never
      // persisted or emailed.
      if (payload.faxNumber) {
        return res.status(201).json({
          success: true,
          message: "Your MeekCall demo is booked.",
          data: null,
        });
      }

      const { scheduledAt, faxNumber, ...demoPayload } = payload;
      const scheduleUpdate =
        await DemoSchedulingService.assertDemoSlotAvailable(
          DemoRequest,
          scheduledAt,
        );
      const bookingToken = DemoSchedulingService.createBookingToken();

      const demoRequest = await Db.saveDemoRequest(DemoRequest, {
        ...demoPayload,
        source: demoPayload.source || "website",
        bookingTokenHash:
          DemoSchedulingService.hashBookingToken(bookingToken),
        ...scheduleUpdate,
      });

      // A Book Demo record becomes visible to admins only after the customer
      // has selected a real slot and the scheduled record exists.
      emitAdminRefresh("demo_scheduled", demoRequest);
      await DemoNotificationService.notifyScheduled(demoRequest, bookingToken);

      const publicRequest = publicDemo(demoRequest);
      return res.status(201).json({
        success: true,
        message: "Your MeekCall demo is booked.",
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

      const handled = bookingError(res, error);
      if (handled) return handled;

      safeConsole.error("Error in bookDemoRequest:", error);
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
      safeConsole.error("Error in getDemoAvailability:", error);
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

      safeConsole.error("Error in getPublicDemoRequest:", error);
      return Response.responseServerError(res);
    }
  }
}
