import mongoose from "mongoose";
import connectDB from "../../src/db/connection.js";

jest.mock("mongoose", () => ({
  __esModule: true,
  default: {
    connect: jest.fn(),
    connection: { readyState: 1 },
  },
}));

describe("MongoDB connection configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      MONGO_URL: "mongodb://localhost/callbackiq-test",
    };
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(process, "exit").mockImplementation(() => undefined);
    mongoose.connect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  test("connects with safe defaults and returns mongoose.connection", async () => {
    await expect(connectDB()).resolves.toBe(mongoose.connection);
    expect(mongoose.connect).toHaveBeenCalledWith(
      "mongodb://localhost/callbackiq-test",
      expect.objectContaining({
        autoIndex: true,
        maxPoolSize: 20,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 10000,
        waitQueueTimeoutMS: 10000,
        maxIdleTimeMS: 30000,
      }),
    );
    expect(process.exit).not.toHaveBeenCalled();
  });

  test("bounds pool values and disables automatic indexes in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.MONGO_MAX_POOL_SIZE = "0";
    process.env.MONGO_MIN_POOL_SIZE = "999";
    process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS = "2500";
    process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS = "-1";
    process.env.MONGO_MAX_IDLE_TIME_MS = "invalid";

    await connectDB();

    expect(mongoose.connect).toHaveBeenCalledWith(
      process.env.MONGO_URL,
      expect.objectContaining({
        autoIndex: false,
        maxPoolSize: 1,
        minPoolSize: 1,
        serverSelectionTimeoutMS: 2500,
        waitQueueTimeoutMS: 10000,
        maxIdleTimeMS: 30000,
      }),
    );
  });

  test("logs and exits when all MongoDB connection URLs are missing", async () => {
    delete process.env.MONGODB_URI;
    delete process.env.MONGO_URL;
    delete process.env.MONGO_URI;
    await expect(connectDB()).resolves.toBeUndefined();
    expect(mongoose.connect).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "MongoDB connection failed:",
      "MONGODB_URI is missing (legacy MONGO_URL/MONGO_URI are also accepted)",
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test("logs and exits when mongoose rejects the connection", async () => {
    mongoose.connect.mockRejectedValue(new Error("connection refused"));
    await expect(connectDB()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      "MongoDB connection failed:",
      "connection refused",
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
