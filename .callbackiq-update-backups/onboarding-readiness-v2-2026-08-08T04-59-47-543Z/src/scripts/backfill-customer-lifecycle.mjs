import "dotenv/config";
import mongoose from "mongoose";

import Appointment from "../models/appointment.js";
import Conversation from "../models/conversation.js";
import Lead from "../models/lead.js";
import VoiceSession from "../models/voiceSession.js";
import { syncCustomerLifecycle } from "../services/customerLifecycle.service.js";

const uri =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.DATABASE_URL ||
  "";

if (!uri) {
  console.error("Set MONGODB_URI or MONGO_URI before running this backfill.");
  process.exit(1);
}

await mongoose.connect(uri);

let processed = 0;
const cursor = Lead.find({}).cursor();

for await (const lead of cursor) {
  const [conversations, appointments, voiceSessions] = await Promise.all([
    Conversation.find({ business: lead.business, lead: lead._id }).lean(),
    Appointment.find({ business: lead.business, lead: lead._id }).lean(),
    VoiceSession.find({ business: lead.business, lead: lead._id }).lean(),
  ]);

  await syncCustomerLifecycle({
    businessId: lead.business,
    lead: lead.toObject(),
    conversations,
    appointments,
    voiceSessions,
  });
  processed += 1;
}

console.log(`Backfilled canonical customer lifecycle for ${processed} leads.`);
await mongoose.disconnect();
