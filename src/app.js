import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

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

const app = express();

app.set("trust proxy", 1);

const allowedOrigins = [
  "http://localhost:3001",
  "http://localhost:5173",
  process.env.CLIENT_URL,
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked origin: ${origin}`));
    },
    credentials: true,
  }),
);

/*
  Stripe webhooks must be registered BEFORE express.json().
  Stripe signature verification requires the raw request body.
*/
app.use("/api/billing", stripeWebhookRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "CallBackIQ API is running",
  });
});

export default app;
