#!/usr/bin/env node

// CALLBACKIQ_SMS_PRODUCTION_HANDOFF_V1
// Deletes one explicitly identified SMS test conversation and its dependent records.
// Dry-run is the default. Nothing is deleted unless --apply is supplied.

import crypto from "node:crypto";
import process from "node:process";
import mongoose from "mongoose";

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? String(args[index + 1] || "").trim() : "";
};

const options = {
  business: valueAfter("--business"),
  conversation: valueAfter("--conversation"),
  customer: valueAfter("--customer"),
  apply: hasFlag("--apply"),
  resetCustomerUsage: hasFlag("--reset-customer-usage"),
  deleteOrphanLead: hasFlag("--delete-orphan-lead"),
};

const usage = () => {
  console.error(`
Usage:
  node --env-file=.env scripts/remove-sms-test-flow.mjs \\
    --business <businessObjectId> \\
    --conversation <conversationObjectId> \\
    --customer <E.164 phone> \\
    [--reset-customer-usage] [--delete-orphan-lead] [--apply]

Safety:
  • Dry-run is the default.
  • The conversation must belong to the exact business and customer phone.
  • Business-wide usage counters and business configuration are never deleted.
`);
};

const fail = (message) => {
  usage();
  throw new Error(message);
};

if (!process.env.MONGO_URL) fail("MONGO_URL is missing.");
if (!mongoose.isObjectIdOrHexString(options.business)) {
  fail("--business must be a valid ObjectId.");
}
if (!mongoose.isObjectIdOrHexString(options.conversation)) {
  fail("--conversation must be a valid ObjectId.");
}
if (!/^\+[1-9]\d{7,14}$/.test(options.customer)) {
  fail("--customer must be an E.164 phone number, such as +16785768258.");
}

const businessId = new mongoose.Types.ObjectId(options.business);
const conversationId = new mongoose.Types.ObjectId(options.conversation);
const customerScopeKey = crypto
  .createHash("sha256")
  .update(options.customer)
  .digest("hex");

const toIdStrings = (documents) => documents.map((document) => String(document._id));


await mongoose.connect(process.env.MONGO_URL);
const db = mongoose.connection.db;

try {
  const business = await db.collection("businesses").findOne(
    { _id: businessId },
    { projection: { businessName: 1, phone: 1 } },
  );
  if (!business) throw new Error("The requested business does not exist.");

  const conversation = await db.collection("conversations").findOne({
    _id: conversationId,
    business: businessId,
    $or: [
      { customerPhone: options.customer },
      { customerPhoneLookup: options.customer },
    ],
  });
  if (!conversation) {
    throw new Error(
      "Safety check failed: the conversation does not belong to the exact business and customer phone.",
    );
  }

  const leadId = conversation.lead || null;
  const messages = await db
    .collection("messages")
    .find({ business: businessId, conversation: conversationId })
    .project({ _id: 1, direction: 1, providerMessageId: 1, body: 1, createdAt: 1 })
    .sort({ createdAt: 1 })
    .toArray();
  const messageIds = messages.map((message) => message._id);
  const messageIdStrings = toIdStrings(messages);

  const appointments = await db
    .collection("appointments")
    .find({ business: businessId, conversation: conversationId })
    .project({ _id: 1 })
    .toArray();
  const appointmentIds = appointments.map((appointment) => appointment._id);

  const queries = {
    smsprocessingjobs: {
      business: businessId,
      $or: [
        { conversation: conversationId },
        ...(messageIds.length ? [{ inboundMessage: { $in: messageIds } }] : []),
      ],
    },
    alerts: {
      business: businessId,
      $or: [
        { conversation: conversationId },
        { "metadata.conversationId": String(conversationId) },
        ...(messageIdStrings.length
          ? [{ "metadata.messageId": { $in: messageIdStrings } }]
          : []),
      ],
    },
    calllogs: { business: businessId, conversation: conversationId },
    appointments: { business: businessId, conversation: conversationId },
    appointmentnotificationjobs: appointmentIds.length
      ? { business: businessId, appointment: { $in: appointmentIds } }
      : { _id: { $in: [] } },
    automationjobs: {
      business: businessId,
      $or: [
        { conversation: conversationId },
        { "metadata.conversationId": String(conversationId) },
      ],
    },
    messages: { business: businessId, conversation: conversationId },
    conversations: { _id: conversationId, business: businessId },
  };

  let usageCounterIds = [];
  if (options.resetCustomerUsage) {
    const usageCounters = await db
      .collection("communicationusages")
      .find({
        business: businessId,
        scope: "customer",
        scopeKey: customerScopeKey,
      })
      .project({ _id: 1 })
      .toArray();
    usageCounterIds = usageCounters.map((counter) => counter._id);
    queries.communicationusagereservations = usageCounterIds.length
      ? { business: businessId, counterIds: { $in: usageCounterIds } }
      : { _id: { $in: [] } };
    queries.communicationusages = {
      business: businessId,
      scope: "customer",
      scopeKey: customerScopeKey,
    };
  }

  const counts = {};
  for (const [collectionName, query] of Object.entries(queries)) {
    counts[collectionName] = await db
      .collection(collectionName)
      .countDocuments(query);
  }

  console.log("\nCallBackIQ SMS test-flow cleanup");
  console.log(`Mode: ${options.apply ? "APPLY" : "DRY RUN"}`);
  console.log(`Business: ${business.businessName || business._id} (${business._id})`);
  console.log(`Conversation: ${conversationId}`);
  console.log(`Customer: ${options.customer}`);
  console.log(`Lead: ${leadId || "none"}`);
  console.log(`Customer usage reset: ${options.resetCustomerUsage ? "yes" : "no"}`);
  console.log(`Delete orphan lead: ${options.deleteOrphanLead ? "yes" : "no"}`);
  console.log("\nRecords selected:");
  for (const [collectionName, count] of Object.entries(counts)) {
    console.log(`  ${collectionName.padEnd(32)} ${count}`);
  }

  console.log("\nMessages selected:");
  for (const message of messages) {
    const body = String(message.body || "").replace(/\s+/g, " ").slice(0, 100);
    console.log(
      `  ${message.createdAt?.toISOString?.() || "unknown-time"} ${String(
        message.direction || "unknown",
      ).padEnd(8)} ${message._id} ${JSON.stringify(body)}`,
    );
  }

  if (!options.apply) {
    console.log(
      "\nDry-run complete. No records were deleted. Add --apply only after verifying the IDs and counts above.",
    );
    process.exitCode = 0;
  } else {
    const deletionOrder = [
      "smsprocessingjobs",
      "alerts",
      "appointmentnotificationjobs",
      "automationjobs",
      "calllogs",
      "appointments",
      "messages",
      "conversations",
      "communicationusagereservations",
      "communicationusages",
    ].filter((collectionName) => queries[collectionName]);

    const deleted = {};
    for (const collectionName of deletionOrder) {
      const result = await db
        .collection(collectionName)
        .deleteMany(queries[collectionName]);
      deleted[collectionName] = result.deletedCount;
    }

    let leadDeleted = 0;
    let leadKeptReason = "No lead was linked to the conversation.";
    if (leadId && options.deleteOrphanLead) {
      const otherReferences = await Promise.all([
        db.collection("conversations").countDocuments({ lead: leadId }),
        db.collection("messages").countDocuments({ lead: leadId }),
        db.collection("calllogs").countDocuments({ lead: leadId }),
        db.collection("appointments").countDocuments({ lead: leadId }),
        db.collection("alerts").countDocuments({ lead: leadId }),
      ]);
      const remainingReferences = otherReferences.reduce(
        (total, count) => total + count,
        0,
      );

      if (remainingReferences === 0) {
        const result = await db.collection("leads").deleteOne({
          _id: leadId,
          business: businessId,
        });
        leadDeleted = result.deletedCount;
        leadKeptReason = leadDeleted
          ? "Deleted because no other records referenced it."
          : "Lead did not match the exact business guard.";
      } else {
        leadKeptReason = `Kept because ${remainingReferences} other record(s) still reference it.`;
      }
    } else if (leadId) {
      leadKeptReason = "Kept because --delete-orphan-lead was not supplied.";
    }

    console.log("\nDeleted records:");
    for (const [collectionName, count] of Object.entries(deleted)) {
      console.log(`  ${collectionName.padEnd(32)} ${count}`);
    }
    console.log(`  ${"leads".padEnd(32)} ${leadDeleted}`);
    console.log(`\nLead result: ${leadKeptReason}`);

    const conversationStillExists = await db
      .collection("conversations")
      .countDocuments({ _id: conversationId });
    const messagesStillExist = await db
      .collection("messages")
      .countDocuments({ business: businessId, conversation: conversationId });

    if (conversationStillExists || messagesStillExist) {
      throw new Error(
        `Post-delete verification failed: conversation=${conversationStillExists}, messages=${messagesStillExist}`,
      );
    }

    console.log("\nCleanup verified. The selected conversation and its SMS messages are gone.");
  }
} finally {
  await mongoose.disconnect();
}
