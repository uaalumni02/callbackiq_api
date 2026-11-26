import mongoose from "mongoose";
import Override from "../../models/providerBudgetOverride.js";
import Business from "../../models/business.js";
import AdminActionLog from "../../models/adminActionLog.js";
import { pilotBudget } from "../../config/pilotBudgets.js";
const invalid = (message) =>
  Object.assign(new Error(message), {
    code: "INVALID_BUDGET_OVERRIDE",
    statusCode: 400,
  });
const checkedRestrictions = (limits) => {
  const checked = {};
  for (const [metric, value] of Object.entries(limits)) {
    const plan = pilotBudget(metric);
    checked[metric] = {};
    for (const [period, amount] of Object.entries(value || {})) {
      if (
        !["daily", "monthly"].includes(period) ||
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        amount > plan[period]
      )
        throw invalid("Overrides can only reduce plan spending allowances.");
      checked[metric][period] = amount;
    }
  }
  return checked;
};
/** Saves audited admin restrictions only; pilot ceilings can never be raised or disabled. */
export async function restrictProviderBudget({
  admin,
  businessId,
  limits,
  reason,
}) {
  if (admin?.role !== "admin")
    throw Object.assign(new Error("Admin access required"), {
      statusCode: 403,
    });
  if (
    !reason ||
    String(reason).length > 500 ||
    !limits ||
    typeof limits !== "object"
  )
    throw invalid("A bounded reason and spending restrictions are required.");
  const checked = checkedRestrictions(limits);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      if (!(await Business.exists({ _id: businessId }).session(session)))
        throw invalid("Business not found.");
      result = await Override.findOneAndUpdate(
        { business: businessId },
        { $set: { limits: checked, reason, admin: admin.userId } },
        { upsert: true, returnDocument: "after", runValidators: true, session },
      );
      await AdminActionLog.create(
        [
          {
            admin: admin.userId,
            targetBusiness: businessId,
            action: "update_provider_budget",
            message: "Pilot spending restrictions updated",
            metadata: { limits: checked, reason },
          },
        ],
        { session },
      );
    });
    return result;
  } finally {
    await session.endSession();
  }
}
