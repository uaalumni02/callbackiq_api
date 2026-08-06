#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const target = path.join(root, "src/services/booking/bookingStateMachine.service.js");
const fail = (message) => {
  console.error(`Google Calendar cancellation hotfix verification failed: ${message}`);
  process.exit(1);
};
if (!fs.existsSync(target)) fail("bookingStateMachine.service.js was not found");
const source = fs.readFileSync(target, "utf8");
const required = [
  'status: "not_started"',
  "appointment: null",
  "selectedSlot: null",
  "offeredSlots: []",
  "Customer requested cancellation by",
];
for (const token of required) {
  if (!source.includes(token)) fail(`missing ${token}`);
}
const cancelStart = source.indexOf("Customer requested cancellation by");
const cancelWindow = source.slice(cancelStart, cancelStart + 1200);
if (cancelWindow.includes('status: "canceled"')) {
  fail('conversation cancellation still writes status "canceled"');
}
console.log("Google Calendar cancellation hotfix verification passed: 6 checks.");
