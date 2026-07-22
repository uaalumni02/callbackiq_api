import "dotenv/config";

import mongoose from "mongoose";
import { createServer } from "http";
import { Server } from "socket.io";

import app from "./app.js";
import connectDB from "./db/connection.js";

import socketAuth from "./middleware/socket-auth.js";
import SocketService from "./services/socket.service.js";
import { socketCorsOptions } from "./config/cors.js";

const port = Number(process.env.PORT) || 3000;
const shutdownTimeoutMs =
  Number(process.env.SHUTDOWN_TIMEOUT_MS) > 0
    ? Number(process.env.SHUTDOWN_TIMEOUT_MS)
    : 10000;

/*
|--------------------------------------------------------------------------
| Create HTTP and Socket.IO servers
|--------------------------------------------------------------------------
|
| Socket.IO must attach to the HTTP server rather than directly to Express.
|
*/

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: socketCorsOptions,
  transports: ["websocket", "polling"],
  serveClient: false,
});

/*
|--------------------------------------------------------------------------
| Make Socket.IO available throughout the application
|--------------------------------------------------------------------------
*/

SocketService.initialize(io);

/*
|--------------------------------------------------------------------------
| Authenticate every socket connection
|--------------------------------------------------------------------------
*/

io.use(socketAuth);

/*
|--------------------------------------------------------------------------
| Socket connection lifecycle
|--------------------------------------------------------------------------
*/

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
    if (!socket.data.businessId) {
      return;
    }

    SocketService.emitDashboardRefresh(socket.data.businessId, "manual");
  });

  socket.on("ping", () => {
    socket.emit("pong", {
      timestamp: Date.now(),
    });
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

/*
|--------------------------------------------------------------------------
| Graceful shutdown
|--------------------------------------------------------------------------
|
| Stop accepting new requests, close active Socket.IO connections, and close
| the MongoDB connection before the process exits.
|
*/

let isShuttingDown = false;

const closeSocketServer = async () => {
  await new Promise((resolve) => {
    io.close(() => resolve());
  });
};

const closeHttpServer = async () => {
  if (!httpServer.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
};

const shutdown = async (signal, exitCode = 0) => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  console.log(`${signal} received. Shutting down CallBackIQ API...`);

  const forcedExitTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out. Forcing process exit.");
    process.exit(1);
  }, shutdownTimeoutMs);

  forcedExitTimer.unref();

  try {
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

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  void shutdown("uncaughtException", 1);
});

/*
|--------------------------------------------------------------------------
| Start the application
|--------------------------------------------------------------------------
|
| The HTTP server does not begin accepting traffic until MongoDB has connected.
|
*/

const startServer = async () => {
  await connectDB();

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
