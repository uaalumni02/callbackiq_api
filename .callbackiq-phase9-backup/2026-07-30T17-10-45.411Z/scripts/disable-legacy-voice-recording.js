import "dotenv/config";
import mongoose from "mongoose";

import Business from "../src/models/business.js";

const supportedMongoVariables = [
  "MONGO_URL",
  "MONGODB_URI",
  "MONGO_URI",
  "MONGODB_URL",
  "DATABASE_URL",
];

const mongoVariableName = supportedMongoVariables.find((variableName) => {
  const value = process.env[variableName];

  return typeof value === "string" && value.trim().length > 0;
});

if (!mongoVariableName) {
  throw new Error(
    [
      "A MongoDB connection string is required.",
      `Configure one of: ${supportedMongoVariables.join(", ")}.`,
    ].join(" "),
  );
}

const mongoUri = process.env[mongoVariableName].trim();

console.log(
  `Connecting to MongoDB using ${mongoVariableName}. The connection string will not be displayed.`,
);

try {
  await mongoose.connect(mongoUri);

  const result = await Business.updateMany(
    {
      "voiceSettings.recordingEnabled": true,
    },
    {
      $set: {
        "voiceSettings.recordingEnabled": false,
      },
    },
  );

  console.log(
    `Disabled legacy voice recording preference for ${
      result.modifiedCount ?? 0
    } business record(s).`,
  );
} catch (error) {
  console.error(
    "The Phase 9 recording migration failed:",
    error instanceof Error ? error.message : error,
  );

  process.exitCode = 1;
} finally {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
