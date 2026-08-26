#!/usr/bin/env node
import "dotenv/config";
import mongoose from "mongoose";

import "../src/models/lead.js";
import "../src/models/conversation.js";
import { performance } from "node:perf_hooks";

import Business from "../src/models/business.js";
import VoiceCapacity from "../src/models/voiceCapacity.js";
import {
  acquireVoiceCapacity,
  releaseVoiceCapacity,
} from "../src/services/voiceCapacity.service.js";

const env = (name, fallback = "") => String(process.env[name] ?? fallback).trim();
const flag = (name) => env(name).toLowerCase() === "true";
const int = (name, fallback, max = 100000) => {
  const parsed = Number.parseInt(env(name, fallback), 10);
  return Math.min(max, Math.max(1, Number.isFinite(parsed) ? parsed : Number(fallback)));
};

const uri = env("MONGODB_URI", env("MONGO_URL", env("MONGO_URI")));
if (!uri) throw new Error("MONGODB_URI is required.");
if (!flag("VOICE_LOAD_ALLOW_DB_WRITES")) {
  throw new Error("Set VOICE_LOAD_ALLOW_DB_WRITES=true for the dedicated load-test database.");
}

await mongoose.connect(uri);
try {
  const dbName = mongoose.connection.name || "";
  if (!/(load|test|perf|benchmark)/i.test(dbName) && !flag("VOICE_LOAD_ALLOW_NONTEST_DB")) {
    throw new Error(`Refusing capacity test against database \"${dbName}\".`);
  }

  const phone = env("VOICE_LOAD_TO", "+12025550123");
  const business = await Business.findOne({ phone });
  if (!business) throw new Error(`No load-test business found for ${phone}. Run voice-load:seed first.`);

  const attempts = int("VOICE_CAPACITY_ATTEMPTS", 50, 1000);
  const expectedMaximum = int(
    "VOICE_CAPACITY_EXPECT_MAX",
    business.voiceSettings?.maxConcurrentCalls || 25,
    100,
  );
  const sessions = Array.from({ length: attempts }, (_, index) => ({
    _id: new mongoose.Types.ObjectId(),
    providerCallSid: `CA${String(index).padStart(32, "0").slice(-32)}`,
  }));

  // Clear stale leases for this synthetic business before the isolated test.
  await VoiceCapacity.updateOne(
    { business: business._id },
    { $set: { leases: [] } },
    { upsert: true },
  );

  const started = performance.now();
  const acquisitions = await Promise.all(
    sessions.map((session) =>
      acquireVoiceCapacity({
        business,
        session,
        settings: business.voiceSettings || {},
      }),
    ),
  );
  const elapsedMs = performance.now() - started;
  const accepted = acquisitions.filter((item) => item.allowed).length;
  const denied = acquisitions.filter((item) => !item.allowed).length;

  const active = await VoiceCapacity.findOne({ business: business._id }).lean();
  const activeBeforeRelease = Array.isArray(active?.leases) ? active.leases.length : 0;

  const allowedSessions = sessions.filter((_, index) => acquisitions[index]?.allowed);
  await Promise.all(
    allowedSessions.map((session) =>
      releaseVoiceCapacity({ businessId: business._id, session }),
    ),
  );

  const after = await VoiceCapacity.findOne({ business: business._id }).lean();
  const activeAfterRelease = Array.isArray(after?.leases) ? after.leases.length : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "voice-capacity-atomic-concurrency",
    database: dbName,
    businessId: String(business._id),
    attempts,
    expectedMaximum,
    accepted,
    denied,
    activeBeforeRelease,
    activeAfterRelease,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    acquireOperationsPerSecond: Number((attempts / Math.max(0.001, elapsedMs / 1000)).toFixed(2)),
    reasons: acquisitions.reduce((acc, item) => {
      const key = item.reason || (item.allowed ? "allowed" : "unknown");
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };

  console.log(JSON.stringify(report, null, 2));
  if (accepted !== Math.min(attempts, expectedMaximum) || activeBeforeRelease !== accepted || activeAfterRelease !== 0) {
    process.exitCode = 1;
  }
} finally {
  await mongoose.disconnect();
}
