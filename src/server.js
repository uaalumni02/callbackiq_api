import { startSmsIngressReconciliationWorker, stopSmsIngressReconciliationWorker } from "./workers/smsIngressReconciliation.worker.js";
import { assertTwilioProductionConfig } from "./config/twilio-production-config.js";
import {
  startConversationLifecycleWorker,
  stopConversationLifecycleWorker,
} from "./workers/conversationLifecycle.worker.js";
import { startSmsProcessingWorker, stopSmsProcessingWorker } from "./workers/smsProcessing.worker.js";
import {
  startVoiceUsageReconciliationWorker,
  stopVoiceUsageReconciliationWorker,
} from "./workers/voiceUsageReconciliation.worker.js";
import "dotenv/config";

import mongoose from "mongoose";
import { createServer } from "http";
import { Server } from "socket.io";

import app from "./app.js";
import connectDB from "./db/connection.js";
import socketAuth from "./middleware/socket-auth.js";
import SocketService from "./services/socket.service.js";
import {
  closeSocketRedisAdapter,
  initializeSocketRedisAdapter,
} from "./services/socketRedisAdapter.service.js";
import { socketCorsOptions } from "./config/cors.js";
import {
  startAutomationWorker,
  stopAutomationWorker,
} from "./workers/automation.worker.js";
import {
  startAppointmentMaintenanceWorker,
  stopAppointmentMaintenanceWorker,
} from "./workers/appointmentMaintenance.worker.js";
import { initializeConversationRelayServer } from "./voice/conversationRelay.server.js";
import { validateEnvironment } from "./config/env.js";
import { startRuntimeMetricsLogging } from "./services/runtimeMetrics.service.js";
import { closeScaleCache } from "./services/scaleCache.service.js";
import {
  assertRealtimeScalingConfig,
  assertServerProcessRole,
  normalizeRuntimeEnvironment,
  shouldRunEmbeddedWorkers,
} from "./config/runtime-environment.js";
// CALLBACKIQ_A2P_RECONCILIATION_WORKER
import {
  startA2pReconciliationWorker,
  stopA2pReconciliationWorker,
} from "./workers/a2pReconciliation.worker.js";
import {
  startTrialLifecycleWorker,
  stopTrialLifecycleWorker,
} from "./workers/trialLifecycle.worker.js";

const port = Number(process.env.PORT) || 3000;
const shutdownTimeoutMs =
  Number(process.env.SHUTDOWN_TIMEOUT_MS) > 0
    ? Number(process.env.SHUTDOWN_TIMEOUT_MS)
    : 10000;

const httpServer = createServer(app);

// CALLBACKIQ_SCALE_HARDENING_V1
const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

httpServer.keepAliveTimeout = positiveInteger(
  process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS,
  65_000,
);
httpServer.headersTimeout = Math.max(
  httpServer.keepAliveTimeout + 1_000,
  positiveInteger(process.env.HTTP_HEADERS_TIMEOUT_MS, 66_000),
);
httpServer.requestTimeout = positiveInteger(
  process.env.HTTP_REQUEST_TIMEOUT_MS,
  30_000,
);
httpServer.maxRequestsPerSocket = positiveInteger(
  process.env.HTTP_MAX_REQUESTS_PER_SOCKET,
  1_000,
);
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
    stopA2pReconciliationWorker();
    stopTrialLifecycleWorker();
    stopAppointmentMaintenanceWorker();
    stopAutomationWorker();
    stopSmsProcessingWorker();
    stopSmsIngressReconciliationWorker();
    stopConversationLifecycleWorker();
    stopVoiceUsageReconciliationWorker();
    await conversationRelayServer.close();
    await closeSocketServer();
    await closeSocketRedisAdapter();
    await closeScaleCache();
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
  assertTwilioProductionConfig();
    // CALLBACKIQ_STARTUP_HARDENING_V1
  normalizeRuntimeEnvironment();
  validateEnvironment(process.env, { throwOnError: true });
  assertServerProcessRole();
  assertRealtimeScalingConfig();
  startRuntimeMetricsLogging();
await connectDB();
  await initializeSocketRedisAdapter(io);
  if (shouldRunEmbeddedWorkers()) {
    startA2pReconciliationWorker();
  }
  if (shouldRunEmbeddedWorkers()) {
    await startTrialLifecycleWorker();
  }
  if (shouldRunEmbeddedWorkers()) {
    startAppointmentMaintenanceWorker();
  }
  if (shouldRunEmbeddedWorkers()) {
    await startAutomationWorker();
  }
  if (shouldRunEmbeddedWorkers()) {
    await startSmsProcessingWorker();
    await startSmsIngressReconciliationWorker();
    startConversationLifecycleWorker();
  }
  if (shouldRunEmbeddedWorkers()) {
    startVoiceUsageReconciliationWorker();
  }
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
