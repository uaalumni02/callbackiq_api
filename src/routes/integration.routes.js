import express from "express";
import IntegrationController from "../controllers/integration.js";
import checkAuth from "../middleware/check-auth.js";
import checkSubscription from "../middleware/check-subscription.js";
const router = express.Router();
/* OAuth callback is authenticated by the signed state, not the browser cookie. */
router.get("/google/callback", IntegrationController.googleCallback);
router.get("/jobber/callback", IntegrationController.jobberCallback);
router.get("/google/connect", checkAuth, checkSubscription, IntegrationController.googleConnect);
router.get("/google/status", checkAuth, IntegrationController.googleStatus);
router.get("/google/calendars", checkAuth, checkSubscription, IntegrationController.googleCalendars);
router.post("/google/calendar", checkAuth, checkSubscription, IntegrationController.googleSelectCalendar);
router.post("/google/disconnect", checkAuth, IntegrationController.googleDisconnect);
router.post("/google/test", checkAuth, checkSubscription, IntegrationController.googleTest);
router.get("/jobber/connect", checkAuth, checkSubscription, IntegrationController.jobberConnect);
router.get("/jobber/status", checkAuth, IntegrationController.jobberStatus);
router.post("/jobber/disconnect", checkAuth, IntegrationController.jobberDisconnect);
router.post("/jobber/test", checkAuth, checkSubscription, IntegrationController.jobberTest);
export default router;
