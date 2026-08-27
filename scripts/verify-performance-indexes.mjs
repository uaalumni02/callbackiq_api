import mongoose from "mongoose";
import connectDB from "../src/db/connection.js";

import Business from "../src/models/business.js";
import Subscription from "../src/models/subscription.js";
import Lead from "../src/models/lead.js";
import Conversation from "../src/models/conversation.js";
import Message from "../src/models/message.js";
import CallLog from "../src/models/callLog.js";

const models = [
  Business,
  Subscription,
  Lead,
  Conversation,
  Message,
  CallLog,
];

const createMissing = process.argv.includes("--create-missing");

const normalize = (value) => {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalize(value[key])]),
  );
};

const relevantOptions = (options = {}) => ({
  unique: Boolean(options.unique),
  sparse: Boolean(options.sparse),
  partialFilterExpression: options.partialFilterExpression || null,
});

const sameIndex = (actual, keys, options) =>
  JSON.stringify(actual.key) === JSON.stringify(keys) &&
  JSON.stringify(normalize(relevantOptions(actual))) ===
    JSON.stringify(normalize(relevantOptions(options)));

await connectDB();

let missing = 0;
let failures = 0;

try {
  for (const model of models) {
    console.log("");
    console.log(`===== ${model.modelName} =====`);

    const existing = await model.collection.indexes();
    const declared = model.schema.indexes();

    for (const [keys, options = {}] of declared) {
      const found = existing.find((index) =>
        sameIndex(index, keys, options),
      );

      if (found) {
        console.log(
          `OK      ${found.name} ${JSON.stringify(keys)}`,
        );
        continue;
      }

      missing += 1;

      const name =
        options.name ||
        Object.entries(keys)
          .map(([key, value]) => `${key}_${value}`)
          .join("_");

      console.log(
        `MISSING ${name} ${JSON.stringify(keys)}`,
      );

      if (!createMissing) {
        continue;
      }

      try {
        const created =
          await model.collection.createIndex(keys, options);

        console.log(`CREATED ${created}`);
      } catch (error) {
        failures += 1;
        console.error(
          `CREATE FAILED ${name}: ${error.message}`,
        );
      }
    }
  }
} finally {
  await mongoose.connection.close();
}

console.log("");
console.log("===== SUMMARY =====");
console.log(`missing indexes: ${missing}`);
console.log(`creation failures: ${failures}`);
console.log(
  `mode: ${createMissing ? "CREATE MISSING" : "CHECK ONLY"}`,
);

if (failures > 0) {
  process.exitCode = 2;
}
