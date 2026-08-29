import "dotenv/config";
import mongoose from "mongoose";
import Appointment from "../src/models/appointment.js";
import CallLog from "../src/models/callLog.js";
import Lead from "../src/models/lead.js";

const mongoUrl = process.env.MONGO_URL || process.env.MONGODB_URI;
if (!mongoUrl) {
  throw new Error("MONGO_URL or MONGODB_URI is required.");
}

await mongoose.connect(mongoUrl);

let scanned = 0;
let firstTouchBackfilled = 0;
let valuesReconciled = 0;
const batch = [];

const flush = async () => {
  if (!batch.length) return;
  await Lead.bulkWrite(batch.splice(0, batch.length), { ordered: false });
};

try {
  const cursor = Lead.find({}).select(
    "_id business appointment firstTrackingNumber firstMarketingSource firstAttribution estimatedValue actualRevenue",
  ).lean().cursor();

  for await (const lead of cursor) {
    scanned += 1;
    const set = {};

    if (!lead.firstTrackingNumber) {
      const earliest = await CallLog.findOne({
        business: lead.business,
        lead: lead._id,
        trackingNumber: { $ne: null },
      })
        .sort({ createdAt: 1, _id: 1 })
        .select("marketingSource trackingNumber attribution")
        .lean();

      if (earliest?.trackingNumber) {
        set.firstMarketingSource = earliest.marketingSource || null;
        set.firstTrackingNumber = earliest.trackingNumber;
        set.firstAttribution = earliest.attribution || {};
        firstTouchBackfilled += 1;
      }
    }

    if (lead.appointment) {
      const appointment = await Appointment.findOne({
        _id: lead.appointment,
        business: lead.business,
      })
        .select("status estimatedValue actualRevenue")
        .lean();

      if (appointment) {
        const estimate = Number(appointment.estimatedValue || 0);
        if (estimate !== Number(lead.estimatedValue || 0)) {
          set.estimatedValue = estimate;
          valuesReconciled += 1;
        }

        if (
          appointment.status === "completed" &&
          Number(appointment.actualRevenue || 0) !== Number(lead.actualRevenue || 0)
        ) {
          set.actualRevenue = Number(appointment.actualRevenue || 0);
          valuesReconciled += 1;
        }
      }
    }

    if (Object.keys(set).length) {
      batch.push({
        updateOne: {
          filter: { _id: lead._id, business: lead.business },
          update: { $set: set },
        },
      });
    }

    if (batch.length >= 250) await flush();
  }

  await flush();
  console.log(
    JSON.stringify(
      {
        scanned,
        firstTouchBackfilled,
        valuesReconciled,
      },
      null,
      2,
    ),
  );
} finally {
  await mongoose.connection.close();
}
