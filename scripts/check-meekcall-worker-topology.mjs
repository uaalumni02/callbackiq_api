#!/usr/bin/env node
/** Static startup topology check; no app modules loaded and no network calls. */
import fs from "node:fs";
const files = {
  "src/server.js": ["shouldRunEmbeddedWorkers()", "startSmsProcessingWorker", "startWebhookWorkWorker"],
  "src/worker.js": ["worker-sms", "worker-automation", "startSmsProcessingWorker", "startAutomationWorker"],
  "src/workers/automation.worker.js": ["processDueAppointmentNotifications", "AUTOMATION_WORKER_ENABLED"],
  "src/services/webhooks/webhookWork.service.js": ["RECOVERY_SMS_ASYNC_ENABLED", "enqueueWebhookWork"],
  "src/workers/webhookWork.worker.js": ["recovery_sms", "startWebhookWorkWorker"],
  "src/routes/admin.routes.js": ["/scale-health", "requireAdmin"],
};
let bad = false;
for (const [file, tokens] of Object.entries(files)) {
  try {
    const source = fs.readFileSync(file, "utf8");
    const missing = tokens.filter(token => !source.includes(token));
    console.log(`${missing.length ? "FAIL" : "PASS"} ${file}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
    if (missing.length) bad = true;
  } catch (err) { console.log(`FAIL ${file}: ${err.code || err.message}`); bad = true; }
}
console.log("Static topology checks do NOT establish a running worker. Configure Render and verify a fresh worker heartbeat before launch.");
if (bad) process.exitCode = 1;
