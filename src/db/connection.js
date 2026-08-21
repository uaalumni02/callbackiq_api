import mongoose from "mongoose";

import { getMongoUrl } from "../config/runtime-environment.js";
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
      throw new Error("MONGODB_URI is missing (legacy MONGO_URL/MONGO_URI are also accepted)");
    }

    const configuredMaxPoolSize = toNonNegativeInteger(
      process.env.MONGO_MAX_POOL_SIZE,
      20,
    );

    const maxPoolSize = Math.max(1, configuredMaxPoolSize);

    const configuredMinPoolSize = toNonNegativeInteger(
      process.env.MONGO_MIN_POOL_SIZE,
      0,
    );

    const minPoolSize = Math.min(configuredMinPoolSize, maxPoolSize);

    await mongoose.connect(DB_URL, {
      /*
       * Automatically create schema indexes locally. Production index
       * creation should remain a controlled deployment operation.
       */
      autoIndex: process.env.NODE_ENV !== "production",

      /*
       * Keep the pool bounded so each deployed API instance cannot consume an
       * excessive number of Atlas connections. Both values can be adjusted
       * through environment variables without changing application code.
       */
      maxPoolSize,
      minPoolSize,

      /*
       * Fail startup reasonably quickly when no MongoDB server can be selected
       * and avoid requests waiting indefinitely for an available connection.
       */
      serverSelectionTimeoutMS: toNonNegativeInteger(
        process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
        10000,
      ),
      waitQueueTimeoutMS: toNonNegativeInteger(
        process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS,
        10000,
      ),

      /*
       * Allow unused sockets to be reclaimed during quieter periods.
       */
      maxIdleTimeMS: toNonNegativeInteger(
        process.env.MONGO_MAX_IDLE_TIME_MS,
        30000,
      ),
    });

    console.log("Connected to MongoDB");
    console.log(
      `Automatic index creation is ${
        process.env.NODE_ENV !== "production" ? "enabled" : "disabled"
      }`,
    );
    console.log(
      `MongoDB connection pool configured: min=${minPoolSize}, max=${maxPoolSize}`,
    );

    return mongoose.connection;
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
};

export default connectDB;
