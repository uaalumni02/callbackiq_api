import express from "express";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.routes.js";
import businessRoutes from "./routes/business.routes.js";
import leadRoutes from "./routes/lead.routes.js";
import conversationRoutes from "./routes/conversation.routes.js";
import messageRoutes from "./routes/message.routes.js";
import callLogRoutes from "./routes/callLog.routes.js";
import twilioRoutes from "./routes/twilio.routes.js";

const app = express();

app.set("trust proxy", 1);

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

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "CallBackIQ API is running",
  });
});

export default app;