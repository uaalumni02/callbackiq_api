import "dotenv/config";
import mongoose from "mongoose";
import Business from "../src/models/business.js";
import { refreshBusinessReport } from "../src/services/admin/founderReporting.service.js";
import {
  AdminBusinessReport,
  AdminBillingFact,
  AdminCostRecord,
  AdminReportingProfile,
  AdminRevenueSnapshot,
  AdminReportingState,
  AdminCompanyExpense,
  AdminExpenseRule,
} from "../src/models/adminReporting.js";
if (!process.env.MONGO_URL) throw new Error("MONGO_URL is required");
try {
  await mongoose.connect(process.env.MONGO_URL);
  for (const Model of [
    AdminBusinessReport,
    AdminBillingFact,
    AdminCostRecord,
    AdminReportingProfile,
    AdminRevenueSnapshot,
    AdminReportingState,
    AdminCompanyExpense,
    AdminExpenseRule,
  ])
    await Model.createIndexes();
  let refreshed = 0,
    failed = 0;
  for await (const business of Business.find({})
    .select("_id")
    .lean()
    .cursor({ batchSize: 25 })) {
    try {
      await refreshBusinessReport(business._id);
      refreshed++;
    } catch (error) {
      failed++;
      console.error(
        "Report failed for business",
        String(business._id),
        error.code || error.name,
      );
    }
  }
  console.log(JSON.stringify({ refreshed, failed }));
  if (failed) process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
