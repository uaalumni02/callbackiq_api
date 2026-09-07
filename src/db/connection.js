import { safeConsole } from "../helpers/logging/safeLogger.js";
// CALLBACKIQ_SCALE_HARDENING_V1
import mongoose from "mongoose";

import {
  getMongoUrl,
  isProductionLike,
} from "../config/runtime-environment.js";

const toNonNegativeInteger = (value, fallback) => {
  const parsedValue = Number.parseInt(value, 10);
  return Number.isInteger(parsedValue) && parsedValue >= 0
    ? parsedValue
    : fallback;
};

const connectDB = async () => {
  try {
    const DB_URL = getMongoUrl();

    if (!DB_URL) {
      throw new Error(
        "MONGODB_URI is missing (legacy MONGO_URL/MONGO_URI are also accepted)",
      );
    }

    const productionLike = isProductionLike();
    const configuredMaxPoolSize = toNonNegativeInteger(
      process.env.MONGO_MAX_POOL_SIZE,
      productionLike ? 40 : 20,
    );
    const maxPoolSize = Math.max(1, configuredMaxPoolSize);

    const configuredMinPoolSize = toNonNegativeInteger(
      process.env.MONGO_MIN_POOL_SIZE,
      productionLike ? 5 : 0,
    );
    const minPoolSize = Math.min(configuredMinPoolSize, maxPoolSize);

    const maxConnecting = Math.max(
      1,
      toNonNegativeInteger(
        process.env.MONGO_MAX_CONNECTING,
        productionLike ? 8 : 2,
      ),
    );

    await mongoose.connect(DB_URL, {
      autoIndex: !productionLike,
      maxPoolSize,
      minPoolSize,
      maxConnecting,
      retryReads: true,
      retryWrites: true,
      serverSelectionTimeoutMS: toNonNegativeInteger(
        process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
        10000,
      ),
      connectTimeoutMS: toNonNegativeInteger(
        process.env.MONGO_CONNECT_TIMEOUT_MS,
        10000,
      ),
      socketTimeoutMS: toNonNegativeInteger(
        process.env.MONGO_SOCKET_TIMEOUT_MS,
        30000,
      ),
      waitQueueTimeoutMS: toNonNegativeInteger(
        process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS,
        10000,
      ),
      maxIdleTimeMS: toNonNegativeInteger(
        process.env.MONGO_MAX_IDLE_TIME_MS,
        30000,
      ),
    });

    safeConsole.log("Connected to MongoDB");
    safeConsole.log(
      `Automatic index creation is ${productionLike ? "disabled" : "enabled"}`,
    );
    safeConsole.log(
      `MongoDB connection pool configured: min=${minPoolSize}, max=${maxPoolSize}, maxConnecting=${maxConnecting}`,
    );

    return mongoose.connection;
  } catch (error) {
    safeConsole.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
};

export default connectDB;
