import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import connectDB from "../src/db/connection.js";

const samples = Math.max(
  5,
  Math.min(
    100,
    Number.parseInt(process.env.MONGO_PING_SAMPLES || "25", 10) || 25,
  ),
);

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
};

await connectDB();

try {
  await mongoose.connection.db.command({ ping: 1 });

  const timings = [];

  for (let i = 0; i < samples; i += 1) {
    const startedAt = performance.now();
    await mongoose.connection.db.command({ ping: 1 });
    timings.push(performance.now() - startedAt);
  }

  const p50 = percentile(timings, 50);
  const p95 = percentile(timings, 95);
  const p99 = percentile(timings, 99);
  const max = Math.max(...timings);

  console.log("");
  console.log("===== MONGO APP-TO-DATABASE LATENCY =====");
  console.log(`samples: ${samples}`);
  console.log(`p50: ${p50.toFixed(2)} ms`);
  console.log(`p95: ${p95.toFixed(2)} ms`);
  console.log(`p99: ${p99.toFixed(2)} ms`);
  console.log(`max: ${max.toFixed(2)} ms`);

  if (p50 > 50) {
    console.log("");
    console.warn(
      "WARNING: Mongo latency is very high. Check Atlas tier, API/Atlas region placement, and network path before increasing connection pools.",
    );
  } else if (p50 > 20) {
    console.log("");
    console.warn(
      "NOTICE: Mongo latency is material and will multiply across sequential database operations.",
    );
  } else {
    console.log("");
    console.log(
      "Mongo network latency looks reasonable. Remaining latency is more likely query count, database workload, or application contention.",
    );
  }
} finally {
  await mongoose.connection.close();
}
