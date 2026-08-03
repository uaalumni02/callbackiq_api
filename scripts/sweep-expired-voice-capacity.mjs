import mongoose from "mongoose";
import { sweepExpiredVoiceCapacity } from "../src/services/voiceCapacity.service.js";

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) {
  console.error("MONGODB_URI or MONGO_URI is required.");
  process.exit(1);
}

try {
  await mongoose.connect(uri);
  const outcome = await sweepExpiredVoiceCapacity();
  console.log(JSON.stringify(outcome, null, 2));
} finally {
  await mongoose.disconnect().catch(() => {});
}
