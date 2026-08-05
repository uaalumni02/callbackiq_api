import "dotenv/config";
import mongoose from "mongoose";

mongoose.set("autoIndex", false);

const apply = process.argv.includes("--apply");
const uri =
  process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL || "";
if (!uri) {
  console.error("MONGODB_URI, MONGO_URI, or MONGO_URL is required.");
  process.exit(1);
}

const normalize = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (String(value || "").startsWith("+") && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  return "";
};

const key = (...parts) => parts.map((part) => String(part || "")).join(":");
const groupBy = (items, getKey) =>
  items.reduce((map, item) => {
    const groupKey = getKey(item);
    if (!groupKey) return map;
    const values = map.get(groupKey) || [];
    values.push(item);
    map.set(groupKey, values);
    return map;
  }, new Map());

await mongoose.connect(uri);
const [
  { default: Lead },
  { default: Conversation },
  { default: Message },
  { default: CallLog },
  { default: SmsProcessingJob },
] = await Promise.all([
  import("../src/models/lead.js"),
  import("../src/models/conversation.js"),
  import("../src/models/message.js"),
  import("../src/models/callLog.js"),
  import("../src/models/smsProcessingJob.js"),
]);

const collections = await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray();
const reassignReferences = async ({ field, fromId, toId }) => {
  for (const { name } of collections) {
    if (name.startsWith("system.")) continue;
    await mongoose.connection.db
      .collection(name)
      .updateMany({ [field]: fromId }, { $set: { [field]: toId } });
  }
};

const mergeLeadData = (canonical, duplicate) => {
  const updates = {};
  const copyIfMissing = [
    "customerName",
    "email",
    "serviceNeeded",
    "address",
    "preferredAppointmentTime",
    "summary",
    "lossReason",
  ];
  for (const field of copyIfMissing) {
    const current = String(canonical[field] || "").trim();
    const candidate = String(duplicate[field] || "").trim();
    if ((!current || current === "Unknown" || current === "Missed Call Lead") && candidate) {
      updates[field] = duplicate[field];
    }
  }
  updates.leadQualityScore = Math.max(
    Number(canonical.leadQualityScore || 0),
    Number(duplicate.leadQualityScore || 0),
  );
  updates.estimatedValue = Math.max(
    Number(canonical.estimatedValue || 0),
    Number(duplicate.estimatedValue || 0),
  );
  updates.actualRevenue = Math.max(
    Number(canonical.actualRevenue || 0),
    Number(duplicate.actualRevenue || 0),
  );
  const notes = [...new Set([canonical.notes, duplicate.notes].map((value) => String(value || "").trim()).filter(Boolean))];
  if (notes.length) updates.notes = notes.join("\n\n").slice(0, 2000);
  return updates;
};

try {
  const leads = await Lead.find({}).sort({ updatedAt: -1, createdAt: -1 }).lean();
  const normalizedLeads = leads
    .map((lead) => ({ ...lead, normalized: normalize(lead.phone) }))
    .filter((lead) => lead.normalized);
  const leadGroups = groupBy(normalizedLeads, (lead) => key(lead.business, lead.normalized));
  const duplicateLeadGroups = [...leadGroups.values()].filter((group) => group.length > 1);

  const conversations = await Conversation.find({})
    .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
    .lean();
  const normalizedConversations = conversations
    .map((conversation) => ({
      ...conversation,
      normalized: normalize(conversation.customerPhone),
      active: conversation.status !== "archived",
    }))
    .filter((conversation) => conversation.normalized);
  const activeConversationGroups = groupBy(
    normalizedConversations.filter((conversation) => conversation.active),
    (conversation) => key(conversation.business, conversation.normalized),
  );
  const duplicateConversationGroups = [...activeConversationGroups.values()].filter(
    (group) => group.length > 1,
  );

  console.log("SMS identity migration audit");
  console.log(`- leads scanned: ${leads.length}`);
  console.log(`- duplicate lead groups: ${duplicateLeadGroups.length}`);
  console.log(`- conversations scanned: ${conversations.length}`);
  console.log(`- duplicate active conversation groups: ${duplicateConversationGroups.length}`);

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to merge duplicates and create indexes.");
    process.exitCode = duplicateLeadGroups.length || duplicateConversationGroups.length ? 2 : 0;
  } else {
    let leadMerges = 0;
    for (const group of duplicateLeadGroups) {
      const [canonical, ...duplicates] = group;
      let canonicalState = { ...canonical };
      const accumulatedUpdates = {};
      for (const duplicate of duplicates) {
        const updates = mergeLeadData(canonicalState, duplicate);
        Object.assign(accumulatedUpdates, updates);
        canonicalState = { ...canonicalState, ...updates };
        await reassignReferences({
          field: "lead",
          fromId: duplicate._id,
          toId: canonical._id,
        });
        await Lead.deleteOne({ _id: duplicate._id });
        leadMerges += 1;
      }
      if (Object.keys(accumulatedUpdates).length) {
        await Lead.updateOne({ _id: canonical._id }, { $set: accumulatedUpdates });
      }
    }

    let conversationMerges = 0;
    const archivedConversationIds = new Set();
    for (const group of duplicateConversationGroups) {
      const [canonical, ...duplicates] = group;
      for (const duplicate of duplicates) {
        await reassignReferences({
          field: "conversation",
          fromId: duplicate._id,
          toId: canonical._id,
        });
        await Conversation.updateOne(
          { _id: duplicate._id },
          {
            $set: {
              status: "archived",
              activeRecord: false,
              archivedAt: new Date(),
              lastMessage: `${duplicate.lastMessage || ""} [Merged into ${canonical._id}]`.trim(),
            },
          },
        );
        archivedConversationIds.add(String(duplicate._id));
        conversationMerges += 1;
      }
    }

    const leadBulk = normalizedLeads.map((lead) => ({
      updateOne: {
        filter: { _id: lead._id },
        update: { $set: { phone: lead.normalized, phoneLookup: lead.normalized } },
      },
    }));
    if (leadBulk.length) await Lead.bulkWrite(leadBulk, { ordered: false });

    const conversationBulk = normalizedConversations.map((conversation) => ({
      updateOne: {
        filter: { _id: conversation._id },
        update: {
          $set: {
            customerPhone: conversation.normalized,
            customerPhoneLookup: conversation.normalized,
            activeRecord:
              conversation.status !== "archived" &&
              !archivedConversationIds.has(String(conversation._id)),
          },
        },
      },
    }));
    if (conversationBulk.length) {
      await Conversation.bulkWrite(conversationBulk, { ordered: false });
    }

    await Promise.all([
      Lead.syncIndexes(),
      Conversation.syncIndexes(),
      Message.syncIndexes(),
      CallLog.syncIndexes(),
      SmsProcessingJob.syncIndexes(),
    ]);

    console.log("Migration applied successfully.");
    console.log(`- duplicate leads merged: ${leadMerges}`);
    console.log(`- duplicate active conversations archived: ${conversationMerges}`);
    console.log("- normalized identity fields populated and indexes synchronized");
  }
} finally {
  await mongoose.disconnect();
}
