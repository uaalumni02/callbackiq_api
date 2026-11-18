import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mongoose from "mongoose";
import { inspectRequiredIndex } from "../src/services/requiredIndexes.service.js";
import { getMongoUrl } from "../src/config/runtime-environment.js";
import { archiveInactiveLead, recomputeLeadWorkflowFlags } from "../src/services/stateTransitions/leadWorkflow.js";
import { queryBudgetMs } from "../src/services/scale/queryBudget.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(root, "config/required-indexes.json");
const [mode = "--check", marker, resumeAfter, ...extra] = process.argv.slice(2);
if (!["--check", "--apply", "--check-manifest", "--write-manifest"].includes(mode) ||
    extra.length || (marker && (mode !== "--apply" || marker !== "--after" || !mongoose.isObjectIdOrHexString(resumeAfter)))) {
  throw new Error("Usage: node scripts/migrate-required-indexes.mjs --check | --apply [--after LEAD_ID] | --check-manifest | --write-manifest");
}

const missingProjection = {
  $or: [
    { workflowFlagsPending: true },
    { "workflowFlags.computedAt": { $not: { $type: "date" } } },
    ...["ready", "needsMe", "waiting"].map(field => ({ [`workflowFlags.${field}`]: { $not: { $type: "bool" } } })),
  ],
};

async function backfillLeadProjections(Lead, after) {
  const newest = await Lead.findOne(missingProjection).sort({ _id: -1 }).select("_id").maxTimeMS(queryBudgetMs()).lean();
  if (!newest) return;
  const now = new Date();
  while (true) {
    const batch = await Lead.find({
      ...missingProjection, _id: { $lte: newest._id, ...(after ? { $gt: after } : {}) },
    }).sort({ _id: 1 }).limit(100).maxTimeMS(queryBudgetMs()).lean();
    if (!batch.length) return;
    for (const lead of batch) {
      await archiveInactiveLead(lead, now);
      await recomputeLeadWorkflowFlags(lead.business, lead._id);
    }
    after = batch.at(-1)._id;
    console.log("Lead workflow backfill through", String(after));
  }
}
// Disable ODM initialization writes before registering any release-data model.
mongoose.set({ autoCreate: false, autoIndex: false });
for (const file of (await fs.readdir(path.join(root, "src/models"))).filter(file => file.endsWith(".js")).sort()) {
  await import(pathToFileURL(path.join(root, "src/models", file)));
}
const definitions = [];
for (const model of Object.values(mongoose.models).sort((a,b) => a.modelName.localeCompare(b.modelName))) {
  for (const [key, raw] of model.schema.indexes()) {
    const options = Object.fromEntries(Object.entries(raw).filter(([k]) => ["unique", "sparse", "expireAfterSeconds", "partialFilterExpression", "collation", "name"].includes(k)));
    const definition = { collection: model.collection.collectionName, key, options };
    if (!definitions.some(d => JSON.stringify(d) === JSON.stringify(definition))) definitions.push(definition);
  }
}
const serialized = JSON.stringify(definitions, null, 2) + "\n";
if (mode === "--write-manifest") {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, serialized);
  console.log(`Recorded ${definitions.length} schema indexes. Review the manifest diff before release.`);
} else if (mode === "--check-manifest") {
  if (serialized !== await fs.readFile(manifestPath, "utf8")) throw new Error("Index manifest differs from schemas. Regenerate and review it.");
  console.log(`Index manifest covers ${definitions.length} schema declarations.`);
} else {
  const required = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (serialized !== JSON.stringify(required, null, 2) + "\n") throw new Error("Stale index manifest");
  const uri = getMongoUrl();
  if (!uri) throw new Error("MONGO_URL is required");
  await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 10000 });
  try {
    let failures = 0;
    for (const definition of required) {
      const collection = mongoose.connection.db.collection(definition.collection);
      let indexes = [];
      try { indexes = await collection.indexes(); } catch (error) { if (error.code !== 26) throw error; }
      const status = inspectRequiredIndex(indexes, definition);
      if (status === "missing" && mode === "--apply") {
        await collection.createIndex(definition.key, definition.options);
        console.log("CREATED", definition.collection, JSON.stringify(definition.key));
      } else if (status !== "ok") {
        failures++;
        console.log(status.toUpperCase(), definition.collection, JSON.stringify(definition.key));
      }
    }
    if (failures) {
      process.exitCode = 2;
      console.error("Required indexes are not ready. Conflicts require a reviewed migration; no indexes were dropped.");
    } else {
      const Lead = mongoose.model("Lead");
      if (mode === "--apply") await backfillLeadProjections(Lead, resumeAfter);
      if (await Lead.exists(missingProjection).maxTimeMS(queryBudgetMs())) {
        process.exitCode = 2;
        console.error("Lead workflow backfill is incomplete. Run the release-data command with --apply.");
      } else {
        console.log("All required indexes and lead workflow projections verified.");
      }
    }
  } finally { await mongoose.disconnect(); }
}
