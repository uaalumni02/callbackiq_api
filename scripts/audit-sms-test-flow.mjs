#!/usr/bin/env node

// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1
// Read-only production SMS flow audit for one business/customer conversation.

import process from "node:process";
import mongoose from "mongoose";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? String(args[index + 1] || "").trim() : "";
};

const businessHex = valueAfter("--business");
const customer = valueAfter("--customer");
const conversationHex = valueAfter("--conversation");

if (!process.env.MONGO_URL) throw new Error("MONGO_URL is missing.");
if (!mongoose.isObjectIdOrHexString(businessHex)) {
  throw new Error("--business must be a valid ObjectId.");
}
if (!/^\+[1-9]\d{7,14}$/.test(customer)) {
  throw new Error("--customer must be an E.164 phone number.");
}
if (conversationHex && !mongoose.isObjectIdOrHexString(conversationHex)) {
  throw new Error("--conversation must be a valid ObjectId when provided.");
}

const businessId = new mongoose.Types.ObjectId(businessHex);
await mongoose.connect(process.env.MONGO_URL);
const db = mongoose.connection.db;

const checks = [];
const pass = (name, detail = "") => checks.push({ result: "PASS", name, detail });
const warn = (name, detail = "") => checks.push({ result: "WARN", name, detail });
const fail = (name, detail = "") => checks.push({ result: "FAIL", name, detail });

try {
  const business = await db.collection("businesses").findOne(
    { _id: businessId },
    { projection: { businessName: 1, phone: 1, isActive: 1 } },
  );
  if (!business) throw new Error("Business not found.");

  const conversationQuery = {
    business: businessId,
    $or: [{ customerPhone: customer }, { customerPhoneLookup: customer }],
  };
  if (conversationHex) {
    conversationQuery._id = new mongoose.Types.ObjectId(conversationHex);
  }

  const conversation = await db
    .collection("conversations")
    .find(conversationQuery)
    .sort({ lastMessageAt: -1, createdAt: -1 })
    .limit(1)
    .next();
  if (!conversation) throw new Error("No matching conversation was found.");

  const messages = await db
    .collection("messages")
    .find({ business: businessId, conversation: conversation._id })
    .sort({ createdAt: 1, _id: 1 })
    .toArray();
  const alerts = await db
    .collection("alerts")
    .find({
      business: businessId,
      $or: [
        { conversation: conversation._id },
        { "metadata.conversationId": String(conversation._id) },
      ],
    })
    .sort({ createdAt: 1 })
    .toArray();
  const jobs = await db
    .collection("smsprocessingjobs")
    .find({ business: businessId, conversation: conversation._id })
    .sort({ createdAt: 1 })
    .toArray();

  console.log("\nCallBackIQ production SMS audit");
  console.log(`Business: ${business.businessName} (${business._id})`);
  console.log(`Customer: ${customer}`);
  console.log(`Conversation: ${conversation._id}`);
  console.log(`Status: ${conversation.status}`);
  console.log(`AI enabled: ${conversation.aiEnabled}`);
  console.log(`Human takeover: ${conversation.humanTakeover}`);
  console.log(
    `Handoff status: ${conversation?.orchestration?.handoffStatus || "(none)"}`,
  );

  console.log("\nMessage timeline:");
  for (const message of messages) {
    const body = String(message.body || "").replace(/\s+/g, " ").slice(0, 180);
    console.log(
      `${message.createdAt?.toISOString?.() || "unknown-time"} ${String(
        message.direction || "unknown",
      ).padEnd(8)} ${String(message.status || "").padEnd(12)} ${JSON.stringify(body)}`,
    );
  }

  if (business.isActive === true) pass("Business is active");
  else fail("Business is active", `isActive=${business.isActive}`);

  const inbound = messages.filter((message) => message.direction === "inbound");
  const outbound = messages.filter((message) => message.direction === "outbound");
  if (inbound.length >= 8) pass("Full customer test depth", `${inbound.length} inbound messages`);
  else warn("Full customer test depth", `${inbound.length} inbound messages; target is at least 8`);
  if (outbound.length >= 1) pass("Outbound replies were persisted", `${outbound.length} outbound messages`);
  else fail("Outbound replies were persisted", "No outbound messages exist");

  const failedOutbound = outbound.filter(
    (message) =>
      message.status === "failed" ||
      message.deliveryStatus === "failed" ||
      message.deliveryUncertain === true,
  );
  if (failedOutbound.length === 0) pass("No failed or uncertain outbound delivery records");
  else fail("No failed or uncertain outbound delivery records", `${failedOutbound.length} found`);

  const pendingOrDeadJobs = jobs.filter((job) =>
    ["queued", "processing", "retry", "dead"].includes(job.status),
  );
  if (pendingOrDeadJobs.length === 0) pass("All SMS processing jobs completed");
  else fail(
    "All SMS processing jobs completed",
    pendingOrDeadJobs.map((job) => `${job._id}:${job.status}`).join(", "),
  );

  const handoffStatus = conversation?.orchestration?.handoffStatus || "";
  if (
    conversation.humanTakeover === true &&
    conversation.aiEnabled === false &&
    ["acknowledged", "delivery_uncertain", "suppressed"].includes(handoffStatus)
  ) {
    pass("Human handoff reached a durable terminal state", handoffStatus);
  } else {
    fail(
      "Human handoff reached a durable terminal state",
      `aiEnabled=${conversation.aiEnabled}, humanTakeover=${conversation.humanTakeover}, handoffStatus=${handoffStatus || "none"}`,
    );
  }

  const handoffInboundId = String(
    conversation?.orchestration?.handoffInboundMessage || "",
  );
  const handoffOutboundId = String(
    conversation?.orchestration?.handoffOutboundMessage || "",
  );
  const handoffInbound = messages.find(
    (message) => String(message._id) === handoffInboundId,
  );
  const handoffOutbound = messages.find(
    (message) => String(message._id) === handoffOutboundId,
  );

  if (handoffInbound) pass("Handoff source inbound message is linked");
  else fail("Handoff source inbound message is linked", handoffInboundId || "missing id");

  if (
    handoffOutbound &&
    String(handoffOutbound.inReplyToMessage || "") === handoffInboundId
  ) {
    pass("Handoff acknowledgement is linked to the triggering inbound message");
  } else {
    fail(
      "Handoff acknowledgement is linked to the triggering inbound message",
      handoffOutboundId || "missing outbound id",
    );
  }

  if (
    /call(?: you at)? the number you're texting from/i.test(
      String(handoffOutbound?.body || ""),
    )
  ) {
    pass("Customer received explicit callback confirmation");
  } else {
    fail("Customer received explicit callback confirmation");
  }

  const handoffAlerts = alerts.filter((alert) =>
    ["human_requested", "safety_emergency"].includes(alert.type),
  );
  if (
    handoffAlerts.some(
      (alert) => alert.actionRequired === true && alert.dueAt,
    )
  ) {
    pass("Business received an actionable callback alert with an SLA");
  } else {
    fail("Business received an actionable callback alert with an SLA");
  }

  const preferredTimeReplies = outbound.filter((message) =>
    /preferred time/i.test(String(message.body || "")),
  );
  if (
    preferredTimeReplies.length === 0 ||
    preferredTimeReplies.every((message) =>
      /not a confirmed appointment/i.test(String(message.body || "")),
    )
  ) {
    pass("Appointment preference language is explicitly unconfirmed");
  } else {
    fail(
      "Appointment preference language is explicitly unconfirmed",
      `${preferredTimeReplies.length} preference reply/replies inspected`,
    );
  }

  const statusAcknowledgements = outbound.filter((message) =>
    /callback request is still with/i.test(String(message.body || "")),
  );
  if (statusAcknowledgements.length === 1) {
    pass("Post-handoff callback-status acknowledgement was sent once");
  } else if (statusAcknowledgements.length === 0) {
    warn(
      "Post-handoff callback-status acknowledgement was sent once",
      "Send the final status-question test message to exercise this path.",
    );
  } else {
    fail(
      "Post-handoff callback-status acknowledgement was sent once",
      `${statusAcknowledgements.length} acknowledgements found`,
    );
  }

  console.log("\nChecks:");
  for (const check of checks) {
    console.log(
      `${check.result.padEnd(5)} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`,
    );
  }

  const failureCount = checks.filter((check) => check.result === "FAIL").length;
  const warningCount = checks.filter((check) => check.result === "WARN").length;
  console.log(`\nResult: ${failureCount} failure(s), ${warningCount} warning(s).`);
  if (failureCount) process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
