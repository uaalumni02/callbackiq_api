import fs from "fs";
import path from "path";

const root = process.cwd();
const checks = [
  ["src/models/lead.js", ["firstAttribution", "latestAttribution"]],
  ["src/models/callLog.js", ["deletedAt", "deletionReason"]],
  ["src/services/analytics/revenueRecovery.service.js", [
    "totalRecoveredAttributableValue",
    "appointmentsBooked",
    "estimatedRecoveredRevenue",
  ]],
  ["src/services/cursorPagination.service.js", [
    "getLeadsOverview",
    "getCallLogsOverview",
  ]],
  ["src/controllers/callLog.js", ["Deleted from Call Activity"]],
];

let failed = false;
for (const [rel, needles] of checks) {
  const content = fs.readFileSync(path.join(root, rel), "utf8");
  for (const needle of needles) {
    if (!content.includes(needle)) {
      console.error(`Missing ${needle} in ${rel}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("Marketing attribution 10/10 API verification passed.");
