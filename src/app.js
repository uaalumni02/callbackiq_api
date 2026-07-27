import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

import { expressCorsOptions } from "./config/cors.js";
import authRoutes from "./routes/auth.routes.js";
import businessRoutes from "./routes/business.routes.js";
import businessFactsRoutes from "./routes/businessFacts.routes.js";
import businessConfigurationRoutes from "./routes/businessConfiguration.routes.js";
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
import healthRoutes from "./routes/health.routes.js";
import appointmentRoutes from "./routes/appointment.routes.js";
import availabilityRoutes from "./routes/availability.routes.js";
import integrationRoutes from "./routes/integration.routes.js";
import automationRoutes from "./routes/automation.routes.js";
import revenueRecoveryRoutes from "./routes/revenueRecovery.routes.js";
import interventionRoutes from "./routes/intervention.routes.js";
import requestContext from "./middleware/request-context.js";
import notFound from "./middleware/not-found.js";
import errorHandler from "./middleware/error-handler.js";

const app = express();
const bodyLimit = process.env.API_BODY_LIMIT || "1mb";

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(requestContext);

/* Stripe signature verification requires the untouched raw body. */
app.use("/api/billing", stripeWebhookRoutes);
app.use(cors(expressCorsOptions));
app.use(express.json({ limit: bodyLimit }));
app.use(
  express.urlencoded({
    extended: true,
    limit: bodyLimit,
  }),
);
app.use(cookieParser());
app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/businesses", businessFactsRoutes);
app.use("/api/businesses", businessRoutes);
app.use("/api/business-configuration", businessConfigurationRoutes);
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

/* Provider-neutral scheduling and recovery platform routes. */
app.use("/api/availability", availabilityRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/automation", automationRoutes);
app.use("/api/analytics/revenue-recovery", revenueRecoveryRoutes);
app.use("/api/interventions", interventionRoutes);

app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "CallBackIQ API is running",
  });
});

app.use(notFound);
app.use(errorHandler);

export default app;
