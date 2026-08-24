import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { expressCorsOptions } from "./config/cors.js";
import authRoutes from "./routes/auth.routes.js";
import businessRoutes from "./routes/business.routes.js";
import a2pCustomerOnboardingRoutes from "./routes/a2pCustomerOnboarding.routes.js";
import a2pEventsRoutes from "./routes/a2pEvents.routes.js";
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
import stripeWebhookRoutes from "./routes/stripeWebHook.routes.js";
import integrationWebhookRoutes from "./routes/integrationWebhook.routes.js";
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
import marketingAttributionRoutes from "./routes/marketingAttribution.routes.js"; // CALLBACKIQ_MARKETING_ATTRIBUTION_V1
import interventionRoutes from "./routes/intervention.routes.js";
import ownerExperienceRoutes from "./routes/ownerExperience.routes.js";
import voiceSettingsRoutes from "./routes/voiceSettings.routes.js";
import customerRecoveryRoutes from "./routes/customerRecovery.routes.js";
import voiceOperationsRoutes from "./routes/voiceOperations.routes.js";
import requestContext from "./middleware/request-context.js";
import securityHeaders from "./middleware/security-headers.js";
import csrfOriginGuard from "./middleware/csrf-origin-guard.js";
import securityResponseMonitor from "./middleware/security-response-monitor.js";
import notFound from "./middleware/not-found.js";
import errorHandler from "./middleware/error-handler.js";

import { resolveTrustProxy } from "./config/runtime-environment.js";
import { requestMetricsMiddleware } from "./services/runtimeMetrics.service.js";
const app = express();
const bodyLimit = process.env.API_BODY_LIMIT || "1mb";

app.disable("x-powered-by");
app.set("trust proxy", resolveTrustProxy());
app.use(requestMetricsMiddleware);
app.use(requestContext);
app.use(securityHeaders);
app.use(securityResponseMonitor);

/* Signature verification requires the untouched request body. */
app.use("/api/billing", stripeWebhookRoutes);
app.use("/api/integration-webhooks", integrationWebhookRoutes);

app.use(cors(expressCorsOptions));
app.use(express.json({ limit: bodyLimit }));
app.use(
  express.urlencoded({
    extended: true,
    limit: bodyLimit,
  }),
);
app.use(cookieParser());
app.use(csrfOriginGuard);
app.use("/api/a2p-events", a2pEventsRoutes);
app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/businesses", businessFactsRoutes);
app.use("/api/businesses", businessRoutes);
app.use("/api/businesses", a2pCustomerOnboardingRoutes);
app.use("/api/business-configuration", businessConfigurationRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/customers", customerRecoveryRoutes);
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
app.use("/api/marketing-sources", marketingAttributionRoutes);
app.use("/api/interventions", interventionRoutes);
app.use("/api/owner", ownerExperienceRoutes);
app.use("/api/voice-settings", voiceSettingsRoutes);
app.use("/api/voice-operations", voiceOperationsRoutes);

app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "CallBackIQ API is running",
  });
});
app.use(notFound);
app.use(errorHandler);

export default app;
