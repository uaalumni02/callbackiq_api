import "dotenv/config";
import mongoose from "mongoose";
import * as reports from "../src/models/adminReporting.js";
import Message from "../src/models/message.js";
import Appointment from "../src/models/appointment.js";
if (!process.env.MONGO_URL) throw new Error("MONGO_URL is required");
try {
  await mongoose.connect(process.env.MONGO_URL, { autoIndex: false });
  for (const Model of Object.values(reports)) await Model.createIndexes();
  await Message.collection.createIndex({
    business: 1,
    lead: 1,
    direction: 1,
    createdAt: -1,
  });
  await Appointment.collection.createIndex({ business: 1, confirmedAt: -1 });
  await Appointment.collection.createIndex({ business: 1, completedAt: -1 });
  console.log(
    "Additive founder reporting indexes installed. No indexes or records dropped.",
  );
} finally {
  await mongoose.disconnect();
}
