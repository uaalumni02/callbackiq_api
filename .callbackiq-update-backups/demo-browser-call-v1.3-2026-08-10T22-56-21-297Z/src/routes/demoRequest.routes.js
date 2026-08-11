import express from "express";
import { rateLimit } from "express-rate-limit";

import DemoRequestController from "../controllers/demoRequest.js";
import DemoBookingController from "../controllers/demoBooking.controller.js";
import DemoOutreachController from "../controllers/demoOutreach.controller.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

const demoCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many demo requests. Please try again in a few minutes.",
  },
});

const demoBookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many booking requests. Please try again shortly.",
  },
});

/* Public lead capture + server-owned scheduling. */
router.get(
  "/availability",
  demoBookingLimiter,
  DemoRequestController.getAvailability,
);
router.post(
  "/book",
  demoCreateLimiter,
  DemoRequestController.bookDemoRequest,
);
router.post("/book", demoCreateLimiter, DemoRequestController.bookDemoRequest);
router.post("/", demoCreateLimiter, DemoRequestController.createDemoRequest);
router.get(
  "/:id/manage",
  demoBookingLimiter,
  DemoRequestController.getPublicDemoRequest,
);
router.post(
  "/:id/schedule",
  demoBookingLimiter,
  DemoRequestController.scheduleDemoRequest,
);
router.post(
  "/:id/reschedule",
  demoBookingLimiter,
  DemoRequestController.rescheduleDemoRequest,
);
router.post(
  "/:id/cancel",
  demoBookingLimiter,
  DemoRequestController.cancelDemoRequest,
);
router.get(
  "/:id/calendar.ics",
  demoBookingLimiter,
  DemoRequestController.getCalendarFile,
);

/* Admin sales-pipeline management. */
router.post(
  "/:id/outreach-attempts",
  checkAuth,
  DemoOutreachController.createContactAttempt,
);
router.post(
  "/:id/emails",
  checkAuth,
  DemoOutreachController.sendEmail,
);
router.get("/", checkAuth, DemoRequestController.getDemoRequests);
router.get("/:id", checkAuth, DemoRequestController.getDemoRequestById);
router.patch("/:id", checkAuth, DemoRequestController.updateDemoRequest);
router.delete("/:id", checkAuth, DemoRequestController.deleteDemoRequest);

export default router;
