import fs from "node:fs";

const mustContain = {
  "src/models/conversation.js": ["pending_business_confirmation", "orchestration", "lifecycle"],
  "src/models/smsProcessingJob.js": ["coalescedInto"],
  "src/services/messaging/smsProcessingQueue.service.js": ["SMS_TURN_COALESCE_MS", "deferInboundSmsJob"],
  "src/workers/smsProcessing.worker.js": ["sms-conversation:", "withDistributedLease"],
  "src/services/messaging/inboundSmsJobProcessor.service.js": ["loadCustomerTurn", "completeCoalescedJobs", "classifySmsIntent"],
  "src/services/messaging/smsTurnPolicy.service.js": ["classifySmsIntent"],
  "src/services/booking/bookingStateMachine.service.js": ["classifySmsIntent"],
  "src/workers/conversationLifecycle.worker.js": ["runConversationLifecycleOnce"],
};

let failed = false;
for (const [path, markers] of Object.entries(mustContain)) {
  if (!fs.existsSync(path)) {
    console.error(`MISSING ${path}`);
    failed = true;
    continue;
  }
  const text = fs.readFileSync(path, "utf8");
  for (const marker of markers) {
    if (!text.includes(marker)) {
      console.error(`MISSING MARKER ${path}: ${marker}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log("SMS conversation hardening structure verified.");
