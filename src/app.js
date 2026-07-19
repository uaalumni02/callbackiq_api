import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

import { expressCorsOptions } from "./config/cors.js";

import authRoutes from "./routes/auth.routes.js";
import businessRoutes from "./routes/business.routes.js";
import leadRoutes from "./routes/lead.routes.js";
import conversationRoutes from "./routes/conversation.routes.js";
import messageRoutes from "./routes/message.routes.js";
import callLogRoutes from "./routes/callLog.routes.js";
import twilioRoutes from "./routes/twilio.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import alertRoutes from "./routes/alert.routes.js";
import agentRoutes from "./routes/agent.routes.js";
import billingRoutes from "./routes/billing.routes.js";
import stripeWebhookRoutes from "./routes/stripeWebhook.routes.js";
import supportRoutes from "./routes/support.routes.js";
import demoRequestRoutes from "./routes/demoRequest.routes.js";
import passwordResetRoutes from "./routes/passwordReset.routes.js";
import conversationIntelligenceRoutes from "./routes/conversationIntelligence.routes.js";

const app = express();

app.set("trust proxy", 1);

/*
  Stripe webhook routes must be registered before:

  - cors()
  - express.json()
  - express.urlencoded()
  - cookieParser()

  Stripe signature verification requires the original raw request body.

  This mount path combined with "/webhook" inside
  stripeWebhook.routes.js creates:

  POST /api/billing/webhook
*/
app.use("/api/billing", stripeWebhookRoutes);

/*
  Normal middleware for frontend and API requests.
*/
app.use(cors(expressCorsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/*
  Application routes.
*/
app.use("/api/auth", authRoutes);
app.use("/api/businesses", businessRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/calls", callLogRoutes);
app.use("/api/twilio", twilioRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/demo-requests", demoRequestRoutes);
app.use("/api/password-reset", passwordResetRoutes);
app.use("/api/conversation-intelligence", conversationIntelligenceRoutes);

/*
  API health-check route.
*/
app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "CallBackIQ API is running",
  });
});

export default app;
