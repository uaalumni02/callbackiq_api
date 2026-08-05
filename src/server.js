import { startSmsProcessingWorker, stopSmsProcessingWorker } from "./workers/smsProcessing.worker.js";
import "dotenv/config";

import mongoose from "mongoose";
import { createServer } from "http";
import { Server } from "socket.io";

import app from "./app.js";
import connectDB from "./db/connection.js";
import socketAuth from "./middleware/socket-auth.js";
import SocketService from "./services/socket.service.js";
import { socketCorsOptions } from "./config/cors.js";
import {
  startAutomationWorker,
  stopAutomationWorker,
} from "./workers/automation.worker.js";
import { initializeConversationRelayServer } from "./voice/conversationRelay.server.js";

const port = Number(process.env.PORT) || 3000;
const shutdownTimeoutMs =
  Number(process.env.SHUTDOWN_TIMEOUT_MS) > 0
    ? Number(process.env.SHUTDOWN_TIMEOUT_MS)
    : 10000;

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: socketCorsOptions,
  transports: ["websocket", "polling"],
  serveClient: false,
});

SocketService.initialize(io);
const conversationRelayServer = initializeConversationRelayServer(httpServer);
io.use(socketAuth);

io.on("connection", (socket) => {
  const user = socket.data.user;
  const business = socket.data.business;

  console.log(
    `Socket connected | User: ${user?.userName} | Business: ${
      business?.businessName || "Admin"
    } | Socket: ${socket.id}`,
  );

  socket.emit("socket:connected", {
    socketId: socket.id,
    connectedAt: new Date().toISOString(),
  });

  socket.on("dashboard:requestRefresh", () => {
    if (!socket.data.businessId) return;
    SocketService.emitDashboardRefresh(socket.data.businessId, "manual");
  });

  socket.on("ping", () => {
    socket.emit("pong", { timestamp: Date.now() });
  });

  socket.on("disconnect", (reason) => {
    console.log(
      `Socket disconnected | User: ${user?.userName} | Reason: ${reason}`,
    );
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });
});

let isShuttingDown = false;

const closeSocketServer = async () => {
  await new Promise((resolve) => io.close(() => resolve()));
};

const closeHttpServer = async () => {
  if (!httpServer.listening) return;
  await new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
};

const shutdown = async (signal, exitCode = 0) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`${signal} received. Shutting down CallBackIQ API...`);
  const forcedExitTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out. Forcing process exit.");
    process.exit(1);
  }, shutdownTimeoutMs);
  forcedExitTimer.unref();

  try {
    stopAutomationWorker();
    stopSmsProcessingWorker();
    await conversationRelayServer.close();
    await closeSocketServer();
    await closeHttpServer();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    clearTimeout(forcedExitTimer);
    console.log("CallBackIQ API shut down cleanly.");
    process.exit(exitCode);
  } catch (error) {
    clearTimeout(forcedExitTimer);
    console.error("Error during graceful shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
  void shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  void shutdown("uncaughtException", 1);
});

const startServer = async () => {
  await connectDB();
  await startAutomationWorker();
  await startSmsProcessingWorker();
  httpServer.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log("Socket.IO server initialized");
  });
};

httpServer.on("error", (error) => {
  console.error("HTTP server error:", error);
  void shutdown("httpServerError", 1);
});

void startServer();
