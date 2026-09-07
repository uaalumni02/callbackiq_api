import { isDraining, getVoiceSnapshot } from "../services/runtimeState.service.js";
import { socketRedisReady } from "../services/socketRedisAdapter.service.js";
import mongoose from "mongoose";

import { validateEnvironment } from "../config/env.js";

const databaseState = () => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  return states[mongoose.connection.readyState] || "unknown";
};

class HealthController {
  static live(req, res) {
    return res.status(200).json({
      success: true,
      status: "live",
      service: "callbackiq-api",
      environment: process.env.APP_ENV || process.env.NODE_ENV || "development",
      uptimeSeconds: Math.floor(process.uptime()),
      requestId: req.context?.requestId || "",
      timestamp: new Date().toISOString(),
    });
  }

  static ready(req, res) {
    const environment = validateEnvironment(process.env, {
      throwOnError: false,
    });
    const database = databaseState();
    const ready = environment.valid && database === "connected" && !isDraining() && socketRedisReady();

    return res.status(ready ? 200 : 503).json({
      success: ready,
      status: ready ? "ready" : "not_ready",
      checks: {
        environment: environment.valid ? "ok" : "failed",
        database,
        draining: isDraining(),
        realtime: socketRedisReady() ? "ok" : "unavailable",
        voice: getVoiceSnapshot(),
      },
      requestId: req.context?.requestId || "",
      timestamp: new Date().toISOString(),
    });
  }
}

export default HealthController;
