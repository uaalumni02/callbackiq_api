import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "../src/db/connection.js";

const FEATURE_DEFAULTS = {
  missedCallSmsEnabled: true,
  aiQualificationEnabled: true,
  aiBookingEnabled: false,
  automatedFollowUpEnabled: false,
  voiceAiEnabled: false,
  revenueTrackingEnabled: false,
  calendarProvider: "internal",
};

const run = async () => {
  await connectDB();

  const result = await mongoose.connection.collection("businesses").updateMany(
    {},
    [
      {
        $set: {
          features: {
            $mergeObjects: [
              FEATURE_DEFAULTS,
              {
                $ifNull: ["$features", {}],
              },
            ],
          },
        },
      },
    ],
  );

  console.log(
    JSON.stringify(
      {
        acknowledged: result.acknowledged,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      },
      null,
      2,
    ),
  );

  await mongoose.connection.close();
};

run().catch(async (error) => {
  console.error("Business feature backfill failed:", error);

  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }

  process.exit(1);
});
