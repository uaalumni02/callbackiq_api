import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "../src/db/connection.js";

const findDuplicates = async (collectionName, providerField) => {
  const collection = mongoose.connection.collection(collectionName);

  return collection
    .aggregate([
      {
        $match: {
          [providerField]: {
            $type: "string",
            $gt: "",
          },
        },
      },
      {
        $group: {
          _id: {
            business: "$business",
            providerId: `$${providerField}`,
          },
          count: {
            $sum: 1,
          },
          recordIds: {
            $push: "$_id",
          },
        },
      },
      {
        $match: {
          count: {
            $gt: 1,
          },
        },
      },
      {
        $sort: {
          count: -1,
        },
      },
    ])
    .toArray();
};

const run = async () => {
  await connectDB();

  const [duplicateMessages, duplicateCalls] = await Promise.all([
    findDuplicates("messages", "providerMessageId"),
    findDuplicates("calllogs", "providerCallId"),
  ]);

  console.log(
    JSON.stringify(
      {
        duplicateMessageGroups: duplicateMessages,
        duplicateCallGroups: duplicateCalls,
      },
      null,
      2,
    ),
  );

  await mongoose.connection.close();

  if (duplicateMessages.length || duplicateCalls.length) {
    console.error(
      "Duplicate provider IDs exist. Resolve them before deploying the unique indexes.",
    );
    process.exit(1);
  }

  console.log("No duplicate Twilio provider IDs were found.");
};

run().catch(async (error) => {
  console.error("Phase 0 duplicate audit failed:", error);

  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }

  process.exit(1);
});
