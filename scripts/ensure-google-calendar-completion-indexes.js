import "dotenv/config";
import mongoose from "mongoose";

import Appointment from "../src/models/appointment.js";
import AppointmentNotificationJob from "../src/models/appointmentNotificationJob.js";
import IntegrationConnection from "../src/models/integrationConnection.js";

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) {
  console.error("Set MONGODB_URI or MONGO_URI before creating indexes.");
  process.exit(1);
}

try {
  await mongoose.connect(uri);
  for (const model of [
    IntegrationConnection,
    Appointment,
    AppointmentNotificationJob,
  ]) {
    await model.createIndexes();
    console.log(`Indexes ensured for ${model.modelName}.`);
  }
} finally {
  await mongoose.disconnect();
}
