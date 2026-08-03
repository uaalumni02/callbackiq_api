import mongoose from "mongoose";
import Business from "../src/models/business.js";
import { normalizePhoneToE164 } from "../src/voice/voicePhone.service.js";

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const applyChanges = process.argv.includes("--apply");
const countryCode = process.env.VOICE_DEFAULT_COUNTRY_CODE || "1";

if (!uri) {
  console.error("MONGODB_URI or MONGO_URI is required.");
  process.exit(1);
}

const normalize = (value) =>
  normalizePhoneToE164(value, { defaultCountryCode: countryCode });

const candidateFields = [
  "phone",
  "forwardingPhone",
  "voiceSettings.transferPhone",
  "voiceSettings.liveTransferPhone",
];

const readPath = (object, path) =>
  path.split(".").reduce((value, key) => value?.[key], object);

try {
  await mongoose.connect(uri);

  const businesses = await Business.find({})
    .select("businessName phone forwardingPhone voiceSettings.transferPhone voiceSettings.liveTransferPhone")
    .lean();

  const report = {
    mode: applyChanges ? "apply" : "dry-run",
    scanned: businesses.length,
    changedBusinesses: 0,
    changedFields: 0,
    skippedInvalid: [],
    changes: [],
  };

  for (const business of businesses) {
    const $set = {};

    for (const field of candidateFields) {
      const current = String(readPath(business, field) || "").trim();
      if (!current) continue;

      const normalized = normalize(current);
      if (!normalized) {
        report.skippedInvalid.push({
          businessId: String(business._id),
          businessName: business.businessName || "",
          field,
          value: current,
        });
        continue;
      }

      if (normalized !== current) {
        $set[field] = normalized;
        report.changes.push({
          businessId: String(business._id),
          businessName: business.businessName || "",
          field,
          from: current,
          to: normalized,
        });
      }
    }

    const fields = Object.keys($set);
    if (!fields.length) continue;

    report.changedBusinesses += 1;
    report.changedFields += fields.length;

    if (applyChanges) {
      await Business.updateOne({ _id: business._id }, { $set });
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (!applyChanges && report.changedFields > 0) {
    console.log("Dry run only. Re-run with --apply after reviewing the report and taking a database backup.");
  }
} finally {
  await mongoose.disconnect().catch(() => {});
}
