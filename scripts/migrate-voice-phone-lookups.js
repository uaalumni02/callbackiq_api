import mongoose from "mongoose";
import Business from "../src/models/business.js";
import { normalizePhoneToE164 } from "../src/voice/voicePhone.service.js";

const uri =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.MONGO_URL;

if (!uri) {
  throw new Error(
    "MONGODB_URI, MONGO_URI, or MONGO_URL is required."
  );
}

await mongoose.connect(uri);

let scanned = 0;
let updated = 0;
let invalid = 0;
let duplicates = 0;
let inactiveCleared = 0;

try {
  const inactiveResult = await Business.updateMany(
    {
      isActive: false,
      phoneLookup: { $exists: true }
    },
    {
      $unset: {
        phoneLookup: ""
      }
    }
  );

  inactiveCleared = inactiveResult.modifiedCount;

  const activeBusinesses = await Business.find({
    isActive: { $ne: false }
  })
    .select("businessName phone phoneLookup isActive")
    .lean();

  scanned = activeBusinesses.length;

  const normalizedBusinesses = [];
  const numberOwners = new Map();

  for (const business of activeBusinesses) {
    const normalized = normalizePhoneToE164(business.phone);

    if (!normalized) {
      invalid += 1;

      console.error(
        `Invalid active-business phone: ${
          business.businessName || business._id
        } (${business.phone || "missing"})`
      );

      continue;
    }

    if (numberOwners.has(normalized)) {
      duplicates += 1;

      console.error(
        `Duplicate active phone ${normalized}: ` +
        `${numberOwners.get(normalized)} and ` +
        `${business.businessName || business._id}`
      );

      continue;
    }

    numberOwners.set(
      normalized,
      business.businessName || business._id.toString()
    );

    normalizedBusinesses.push({
      id: business._id,
      current: business.phoneLookup,
      normalized
    });
  }

  if (invalid === 0 && duplicates === 0) {
    for (const business of normalizedBusinesses) {
      if (business.current !== business.normalized) {
        await Business.updateOne(
          { _id: business.id },
          {
            $set: {
              phoneLookup: business.normalized
            }
          }
        );

        updated += 1;
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        scanned,
        updated,
        invalid,
        duplicates,
        inactiveCleared
      },
      null,
      2
    )
  );
} finally {
  await mongoose.disconnect();
}

if (invalid > 0 || duplicates > 0) {
  process.exitCode = 2;
}
