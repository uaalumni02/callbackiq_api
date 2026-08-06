import express from "express";

import IntegrationController from "../controllers/integration.js";
import IntegrationWebhookController from "../controllers/integrationWebhook.js";
import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";

const router = express.Router();

/* OAuth callbacks are authenticated by one-time signed state, not cookies. */
router.get("/google/callback", IntegrationController.googleCallback);
router.get("/jobber/callback", IntegrationController.jobberCallback);

/* Header-authenticated Google push notification alias. */
router.post("/google/webhook", IntegrationWebhookController.google);

router.get(
  "/google/connect",
  checkAuth,
  checkSubscription,
  IntegrationController.googleConnect,
);
router.get("/google/status", checkAuth, IntegrationController.googleStatus);
router.get(
  "/google/calendars",
  checkAuth,
  checkSubscription,
  IntegrationController.googleCalendars,
);
/* PATCH is canonical; POST remains for backward-compatible clients. */
router.patch(
  "/google/calendar",
  checkAuth,
  checkSubscription,
  IntegrationController.googleSelectCalendar,
);
router.post(
  "/google/calendar",
  checkAuth,
  checkSubscription,
  IntegrationController.googleSelectCalendar,
);
/* Compatibility endpoint used by the settings UI and older clients. */
router.put(
  "/google/settings",
  checkAuth,
  checkSubscription,
  IntegrationController.googleSaveSettings,
);
router.patch(
  "/google/settings",
  checkAuth,
  checkSubscription,
  IntegrationController.googleSaveSettings,
);
router.post(
  "/google/test",
  checkAuth,
  checkSubscription,
  IntegrationController.googleTest,
);
router.post(
  "/google/sync",
  checkAuth,
  checkSubscription,
  IntegrationController.googleSync,
);
router.post(
  "/google/watch",
  checkAuth,
  checkSubscription,
  IntegrationController.googleStartWatch,
);
router.delete(
  "/google/watch",
  checkAuth,
  IntegrationController.googleStopWatch,
);
router.delete(
  "/google/disconnect",
  checkAuth,
  IntegrationController.googleDisconnect,
);
router.post(
  "/google/disconnect",
  checkAuth,
  IntegrationController.googleDisconnect,
);

router.get(
  "/jobber/connect",
  checkAuth,
  checkSubscription,
  IntegrationController.jobberConnect,
);
router.get("/jobber/status", checkAuth, IntegrationController.jobberStatus);
router.post(
  "/jobber/disconnect",
  checkAuth,
  IntegrationController.jobberDisconnect,
);
router.post(
  "/jobber/test",
  checkAuth,
  checkSubscription,
  IntegrationController.jobberTest,
);

export default router;
