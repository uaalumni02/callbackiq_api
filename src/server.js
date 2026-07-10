import "dotenv/config";

import { createServer } from "http";
import { Server } from "socket.io";

import app from "./app.js";
import connectDB from "./db/connection.js";

import socketAuth from "./middleware/socket-auth.js";
import SocketService from "./services/socket.service.js";
import { socketCorsOptions } from "./config/cors.js";

const port = process.env.PORT || 3000;

/*
|--------------------------------------------------------------------------
| Connect to MongoDB
|--------------------------------------------------------------------------
*/

connectDB();

/*
|--------------------------------------------------------------------------
| Create HTTP server
|--------------------------------------------------------------------------
|
| Socket.IO must attach to the HTTP server rather than directly to Express.
|
*/

const httpServer = createServer(app);

/*
|--------------------------------------------------------------------------
| Create Socket.IO server
|--------------------------------------------------------------------------
*/

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

  /*
   * Useful for debugging and confirming connectivity.
   * The frontend can listen for this event after connecting.
   */
  socket.emit("socket:connected", {
    socketId: socket.id,
    connectedAt: new Date().toISOString(),
  });

  /*
   * Allow the frontend to manually request a dashboard refresh.
   * The server simply acknowledges the request; the frontend can
   * then refetch the existing REST endpoint.
   */
  socket.on("dashboard:requestRefresh", () => {
    if (!socket.data.businessId) {
      return;
    }

    SocketService.emitDashboardRefresh(socket.data.businessId, "manual");
  });

  /*
   * Keep connections healthy.
   */
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
| Start HTTP server
|--------------------------------------------------------------------------
*/

httpServer.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log("Socket.IO server initialized");
});
