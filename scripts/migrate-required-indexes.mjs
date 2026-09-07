import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mongoose from "mongoose";
import { inspectRequiredIndex } from "../src/services/requiredIndexes.service.js";
import { getMongoUrl } from "../src/config/runtime-environment.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(root, "config/required-indexes.json");
const args = new Set(process.argv.slice(2));
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
if (args.has("--write-manifest")) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, serialized);
  console.log(`Recorded ${definitions.length} schema indexes. Review the manifest diff before release.`);
} else if (args.has("--check-manifest")) {
  if (serialized !== await fs.readFile(manifestPath, "utf8")) throw new Error("Index manifest differs from schemas. Regenerate and review it.");
  console.log(`Index manifest covers ${definitions.length} schema declarations.`);
} else {
  const required = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (serialized !== JSON.stringify(required, null, 2) + "\n") throw new Error("Stale index manifest");
  const uri = getMongoUrl();
  if (!uri) throw new Error("MONGO_URL is required");
  await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
  try {
    let failures = 0;
    for (const definition of required) {
      const collection = mongoose.connection.db.collection(definition.collection);
      let indexes = [];
      try { indexes = await collection.indexes(); } catch (error) { if (error.code !== 26) throw error; }
      const status = inspectRequiredIndex(indexes, definition);
      if (status === "missing" && args.has("--apply")) {
        await collection.createIndex(definition.key, definition.options);
        console.log("CREATED", definition.collection, JSON.stringify(definition.key));
      } else if (status !== "ok") {
        failures++;
        console.log(status.toUpperCase(), definition.collection, JSON.stringify(definition.key));
      }
    }
    if (failures) { process.exitCode = 2; console.error("Required indexes are not ready. Conflicts require a reviewed migration; no indexes were dropped."); }
    else console.log("All required index semantics verified.");
  } finally { await mongoose.disconnect(); }
}
