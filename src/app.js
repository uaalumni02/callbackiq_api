import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

import { expressCorsOptions } from "./config/cors.js";

import authRoutes from "./routes/auth.routes.js";
import businessRoutes from "./routes/business.routes.js";
import businessFactsRoutes from "./routes/businessFacts.routes.js";
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

import requestContext from "./middleware/request-context.js";
import notFound from "./middleware/not-found.js";
import errorHandler from "./middleware/error-handler.js";

const app = express();

const bodyLimit = process.env.API_BODY_LIMIT || "1mb";

app.disable("x-powered-by");
app.set("trust proxy", 1);

/*
 * Attach one request ID to every request.
 *
 * This must be registered before the routes so that application logs,
 * error responses, Stripe webhook processing, and health checks all use
 * the same request ID.
 */
app.use(requestContext);

/*
 * Stripe webhook routes must be registered before JSON and URL-encoded
 * body parsers. Stripe signature verification requires the original
 * raw request body.
 *
 * This mount path combined with "/webhook" inside
 * stripeWebhook.routes.js produces:
 *
 * POST /api/billing/webhook
 */
app.use("/api/billing", stripeWebhookRoutes);

/*
 * Normal middleware for frontend and API requests.
 */
app.use(cors(expressCorsOptions));
app.use(express.json({ limit: bodyLimit }));
app.use(
  express.urlencoded({
    extended: true,
    limit: bodyLimit,
  }),
);
app.use(cookieParser());

/*
 * Health and readiness routes.
 *
 * Assuming health.routes.js defines "/", "/live", and "/ready",
 * these endpoints become:
 *
 * GET /api/health
 * GET /api/health/live
 * GET /api/health/ready
 */
app.use("/api/health", healthRoutes);

/*
 * Application routes.
 */
app.use("/api/auth", authRoutes);

/*
 * Register the more specific business-facts routes before the general
 * business routes.
 *
 * Assuming businessFacts.routes.js defines "/mine/facts", the endpoint is:
 *
 * GET/PUT /api/businesses/mine/facts
 */
app.use("/api/businesses", businessFactsRoutes);
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
 * Root status route.
 */
app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "CallBackIQ API is running",
  });
});

/*
 * These must remain after every valid application route.
 */
app.use(notFound);
app.use(errorHandler);

export default app;
