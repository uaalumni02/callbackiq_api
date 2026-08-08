#!/usr/bin/env node
import fs from "fs";

const checks = [
  [
    "src/controllers/billing.js",
    "business?.forwardingPhone || business?.businessPhone || business?.phone",
    "billing trial identity uses forwardingPhone",
  ],
  [
    "src/db/db.js",
    '"trackingNumber.status": "active"',
    "webhook DB lookup requires active tracking lifecycle",
  ],
  [
    "src/db/db.js",
    '"trackingNumber",',
    "business scope projects trackingNumber",
  ],
  [
    "src/controllers/auth.js",
    "existingForwardingPhone",
    "registration duplicate check targets forwarding phone",
  ],
  [
    "src/controllers/business.js",
    "delete businessPayload.phone",
    "legacy create phone alias is not persisted as tracking number",
  ],
  [
    "src/validator/business.js",
    '.or("forwardingPhone", "phone")',
    "business create accepts forwarding phone or legacy alias",
  ],
  [
    "src/validator/business.js",
    "phone: Joi.forbidden()",
    "owner updates cannot edit tracking number",
  ],
  [
    "src/services/businessReadiness.service.js",
    "error.statusCode = 400;",
    "booking readiness preserves validation status contract",
  ],
];

const failures = [];
for (const [file, needle, label] of checks) {
  if (!fs.existsSync(file)) {
    failures.push(`${label}: missing ${file}`);
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(needle)) failures.push(`${label}: missing expected marker`);
}

if (failures.length) {
  console.error("Onboarding regression v3 verification failed:\n");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Onboarding regression v3 verification passed: ${checks.length} checks.`);
