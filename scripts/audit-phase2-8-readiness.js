import "dotenv/config";

import mongoose from "mongoose";

import connectDB from "../src/db/connection.js";
import Appointment from "../src/models/appointment.js";
import AutomationJob from "../src/models/automationJob.js";
import ConversionEvent from "../src/models/conversionEvent.js";
import IntegrationConnection from "../src/models/integrationConnection.js";

await connectDB();

const collections = [
  Appointment,
  AutomationJob,
  ConversionEvent,
  IntegrationConnection,
];

let failed = false;

for (const model of collections) {
  const declared = model.schema.indexes().map(([keys, options]) => ({
    keys,
    name: options.name || null,
    unique: Boolean(options.unique),
  }));
  const existing = await model.collection.indexes().catch(() => []);
  console.log(`\n${model.modelName}`);
  console.log(`Declared indexes: ${declared.length}`);
  console.log(`Database indexes: ${existing.length}`);

  const duplicateGroups = [];
  if (model.modelName === "Appointment") {
    duplicateGroups.push(
      ...(await model.aggregate([
        {
          $group: {
            _id: { business: "$business", idempotencyKey: "$idempotencyKey" },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $limit: 20 },
      ])),
    );
  }

  if (duplicateGroups.length) {
    failed = true;
    console.error(`Duplicate groups detected: ${duplicateGroups.length}`);
    console.error(JSON.stringify(duplicateGroups, null, 2));
  }
}

await mongoose.disconnect();
process.exit(failed ? 1 : 0);
