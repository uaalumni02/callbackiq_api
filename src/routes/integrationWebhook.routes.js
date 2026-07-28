import express from "express";
import IntegrationWebhookController from "../controllers/integrationWebhook.js";

const router = express.Router();

router.post(
  "/google",
  express.raw({ type: "application/json", limit: "512kb" }),
  IntegrationWebhookController.google,
);
router.post(
  "/jobber",
  express.raw({ type: "application/json", limit: "512kb" }),
  IntegrationWebhookController.jobber,
);

export default router;
