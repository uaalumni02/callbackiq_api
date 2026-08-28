import fs from "node:fs";
const checks = [
  ["src/services/twilioSmsService.js", "forceDirectSender"],
  ["src/services/twilioSmsService.js", "senderAttached: true"],
  ["src/services/analytics/revenueRecovery.service.js", "totalBookedAttributableValue"],
  ["src/services/analytics/revenueRecovery.service.js", 'type: "job_completed"'],
  ["src/services/analytics/revenueRecovery.service.js", "snapshotSourceName"],
  ["src/services/marketingSource.service.js", "number.releasedAt = new Date()"],
  ["src/services/marketingSource.service.js", "releasedCollision"],
];
let failed = false;
for (const [file, needle] of checks) {
  const text = fs.readFileSync(file, "utf8");
  const ok = text.includes(needle);
  console.log(ok ? "PASS" : "FAIL", file, "::", needle);
  if (!ok) failed = true;
}
process.exitCode = failed ? 1 : 0;
