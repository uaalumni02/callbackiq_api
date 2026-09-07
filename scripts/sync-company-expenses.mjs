import "dotenv/config";
import mongoose from "mongoose";
import {
  syncCompanyExpenses,
  companyExpenseSummary,
} from "../src/services/admin/companyExpenses.service.js";
if (!process.env.MONGO_URL) throw new Error("MONGO_URL is required");
try {
  await mongoose.connect(process.env.MONGO_URL);
  await syncCompanyExpenses({ force: true });
  const report = await companyExpenseSummary();
  console.log(
    JSON.stringify(
      {
        period: report.period,
        providers: report.providers.map((p) => ({
          provider: p.provider,
          complete: p.complete,
          error: p.errorCode || null,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await mongoose.disconnect();
}
