import fs from "fs";
import path from "path";

const read = (relative) =>
  fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");

test("SMS identity and reply idempotency indexes are installed", () => {
  const lead = read("src/models/lead.js");
  const conversation = read("src/models/conversation.js");
  const message = read("src/models/message.js");

  expect(lead).toContain("phoneLookup");
  expect(lead).toMatch(/business:\s*1,\s*phoneLookup:\s*1/);
  expect(lead).toMatch(/unique:\s*true/);

  expect(conversation).toContain("customerPhoneLookup");
  expect(conversation).toContain("activeRecord");
  expect(conversation).toMatch(
    /business:\s*1,\s*customerPhoneLookup:\s*1,\s*activeRecord:\s*1/,
  );

  expect(message).toContain("inReplyToMessage");
  expect(message).toMatch(/business:\s*1,\s*inReplyToMessage:\s*1/);
  expect(message).toContain("SmsMediaSchema");
  expect(message).toContain("segmentCount");
});

test("webhook events and queue jobs have reclaimable leases", () => {
  const webhookEvent = read("src/models/webhookEvent.js");
  const queueModel = read("src/models/smsProcessingJob.js");
  const queueService = read("src/services/messaging/smsProcessingQueue.service.js");

  expect(webhookEvent).toContain("leaseExpiresAt");
  expect(queueModel).toContain("leaseToken");
  expect(queueService).toContain('status: "processing", leaseExpiresAt: { $lte: now }');
});
