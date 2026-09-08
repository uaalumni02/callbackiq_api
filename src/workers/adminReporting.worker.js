import { runProviderBalanceSync } from "../services/admin/providerBalances.service.js";
import { runCompanyExpenseSync } from "../services/admin/companyExpenses.service.js";
import crypto from "node:crypto";
import Business from "../models/business.js";
import { AdminBusinessReport } from "../models/adminReporting.js";
import { refreshBusinessReport } from "../services/admin/founderReporting.service.js";
import { safeConsole } from "../helpers/logging/safeLogger.js";
let timer = null,
  running = null,
  stopped = true,
  expenseTimer = null,
  expenseRunning = null,
  balanceTimer = null,
  balanceRunning = null;
let businessCursor = null;
// Reporting has its own bounded, leased queue. Never run provider writes or
// mutate operational collections. A failed report keeps the last good snapshot.
export const runAdminReportingBatch = async ({
  batchSize = 5,
  now = new Date(),
} = {}) => {
  const businesses = await Business.find(
    businessCursor ? { _id: { $gt: businessCursor } } : {},
  )
    .select("_id businessName")
    .sort({ _id: 1 })
    .limit(100)
    .maxTimeMS(5000)
    .lean();
  for (const business of businesses)
    await AdminBusinessReport.updateOne(
      { business: business._id },
      {
        $setOnInsert: {
          name: business.businessName,
          excluded: false,
          nextRefreshAt: new Date(0),
        },
      },
      { upsert: true },
    );
  businessCursor = businesses.length === 100 ? businesses.at(-1)._id : null;
  let refreshed = 0;
  for (let index = 0; index < batchSize; index++) {
    const token = crypto.randomUUID();
    const report = await AdminBusinessReport.findOneAndUpdate(
      {
        nextRefreshAt: { $lte: now },
        $or: [{ leaseUntil: { $lte: now } }, { leaseUntil: null }],
      },
      { $set: { leaseUntil: new Date(+now + 600000), leaseToken: token } },
      { sort: { nextRefreshAt: 1 }, returnDocument: "after" },
    ).lean();
    if (!report) break;
    try {
      await refreshBusinessReport(report.business, now);
      refreshed++;
    } catch (error) {
      await AdminBusinessReport.updateOne(
        { _id: report._id, leaseToken: token },
        {
          $set: {
            failureCode: "REPORT_REFRESH_FAILED",
            nextRefreshAt: new Date(+now + 60000),
          },
        },
      );
      safeConsole.error("Admin report refresh failed", {
        business: String(report.business),
        code: error?.code || "REPORT_REFRESH_FAILED",
      });
    } finally {
      await AdminBusinessReport.updateOne(
        { _id: report._id, leaseToken: token },
        { $unset: { leaseUntil: 1, leaseToken: 1 } },
      );
    }
  }
  return { refreshed };
};
export const startAdminReportingWorker = () => {
  if (
    !stopped ||
    process.env.ADMIN_REPORTING_ENABLED === "false" ||
    process.env.NODE_ENV === "test"
  )
    return;
  stopped = false;
  const tick = () => {
    if (stopped) return;
    running = runAdminReportingBatch()
      .catch((error) =>
        safeConsole.error("Admin reporting unavailable", {
          code: error?.code || "REPORTING_ERROR",
        }),
      )
      .finally(() => {
        running = null;
        if (!stopped) {
          timer = setTimeout(tick, 5000);
          timer.unref?.();
        }
      });
  };
  const expenseTick = () => {
    if (stopped) return;
    expenseRunning = runCompanyExpenseSync()
      .catch(() =>
        safeConsole.error("Company expense reporting sync unavailable"),
      )
      .finally(() => {
        expenseRunning = null;
        if (!stopped) {
          expenseTimer = setTimeout(expenseTick, 30000);
          expenseTimer.unref?.();
        }
      });
  };
  const balanceTick = () => {
    if (stopped) return;
    balanceRunning = runProviderBalanceSync()
      .catch(() => safeConsole.error("Provider balance reporting unavailable"))
      .finally(() => {
        balanceRunning = null;
        if (!stopped) {
          balanceTimer = setTimeout(balanceTick, 30000);
          balanceTimer.unref?.();
        }
      });
  };
  balanceTimer = setTimeout(balanceTick, 1000);
  balanceTimer.unref?.();
  expenseTimer = setTimeout(expenseTick, 2000);
  expenseTimer.unref?.();
  timer = setTimeout(tick, 1000);
  timer.unref?.();
};
export const stopAdminReportingWorker = async () => {
  stopped = true;
  clearTimeout(timer);
  clearTimeout(expenseTimer);
  clearTimeout(balanceTimer);
  // Do not delay core worker shutdown for provider pagination. Outstanding
  // reporting leases expire naturally if the process exits before completion.
  let timeout;
  try {
    await Promise.race([
      Promise.allSettled(
        [running, expenseRunning, balanceRunning].filter(Boolean),
      ),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
