// CALLBACKIQ_SCALE_HARDENING_V1
import fs from "fs";

const required = [
  ["src/services/scaleCache.service.js", "getOrLoadScaleCache"],
  ["src/controllers/dashboard.js", "ScaleCache.getOrLoad"],
  ["src/controllers/ownerExperience.js", "marketingSources"],
  ["src/controllers/revenueRecovery.js", "static async overview"],
  ["src/routes/revenueRecovery.routes.js", 'router.get("/overview"'],
  ["src/workers/smsProcessing.worker.js", "SMS_PROCESSING_CONCURRENCY"],
  ["scripts/migrate-scale-indexes.mjs", "conversion_business_type_occurred"],
  ["src/db/connection.js", "MONGO_MAX_CONNECTING"],
  ["src/server.js", "HTTP_KEEP_ALIVE_TIMEOUT_MS"],
];

let failed = false;

for (const [file, marker] of required) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!text.includes(marker)) {
    console.error(`MISSING ${file}: ${marker}`);
    failed = true;
  } else {
    console.log(`OK ${file}`);
  }
}

if (failed) process.exit(1);
console.log("CallBackIQ scale-hardening structure verified.");
