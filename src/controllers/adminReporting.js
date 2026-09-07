import { EXPENSE_PROVIDERS } from "../services/admin/companyExpenses.service.js";
import Joi from "joi";
import Business from "../models/business.js";
import AdminActionLog from "../models/adminActionLog.js";
import {
  AdminReportingProfile,
  AdminBusinessReport,
  AdminCostRecord,
  AdminCompanyExpense,
  AdminExpenseRule,
  AdminReportingState,
} from "../models/adminReporting.js";
import {
  founderOverview,
  listCustomers,
  getSafeCustomerDetails,
} from "../services/admin/founderReporting.service.js";
import { COST_CATEGORIES } from "../services/admin/reportingPolicy.js";
import { deleteScaleCacheKey } from "../services/scaleCache.service.js";
const id = Joi.string().hex().length(24).required();
const query = Joi.object({
  days: Joi.number().valid(7, 30, 90).default(30),
  page: Joi.number().integer().min(1).max(100000).default(1),
  limit: Joi.number().integer().min(1).max(100).default(25),
  search: Joi.string().trim().max(100).allow("").default(""),
  attention: Joi.boolean().default(false),
  includeExcluded: Joi.boolean().default(false),
});
const profileSchema = Joi.object({
  excluded: Joi.boolean(),
  exclusionReason: Joi.string().trim().max(200).allow(""),
  acquisitionSource: Joi.string().trim().max(100).allow(""),
  cancellationReason: Joi.string().trim().max(200).allow(""),
  nextAction: Joi.string().trim().max(300).allow(""),
  followUpAt: Joi.date().iso().allow(null),
}).min(1);
const costSchema = Joi.object({
  period: Joi.string()
    .pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
    .required(),
  category: Joi.string()
    .valid(...COST_CATEGORIES)
    .required(),
  amountCents: Joi.number().integer().min(0).max(100000000).required(),
  basis: Joi.string().valid("estimated", "reconciled").required(),
  throughDate: Joi.date().iso().max("now").required(),
  supportMinutes: Joi.number().min(0).max(100000).default(0),
  reference: Joi.string().trim().min(1).max(200).required(),
});
const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    res.status(error.isJoi ? 400 : 500).json({
      success: false,
      message: error.isJoi
        ? error.message
        : "Admin reporting is temporarily unavailable. Existing customer operations are unaffected.",
    });
  }
};
const ok = (res, data) => res.json({ success: true, data });
const businessId = async (req) => id.validateAsync(req.params.businessId);
const exists = async (key, res) => {
  if (await Business.exists({ _id: key })) return true;
  res
    .status(404)
    .json({ success: false, message: "Customer business not found" });
  return false;
};
const invalidate = async (key) => {
  await AdminBusinessReport.updateOne(
    { business: key },
    { $set: { nextRefreshAt: new Date(0) } },
  );
  await Promise.all(
    [7, 30, 90].map((days) => deleteScaleCacheKey(`admin:founder:v1:${days}`)),
  );
};
export const getFounderDashboard = wrap(async (req, res) => {
  const q = await query.validateAsync(req.query);
  const [founder, customers] = await Promise.all([
    founderOverview(q.days),
    listCustomers(q),
  ]);
  ok(res, { founder, ...customers });
});
export const getFounderCustomers = wrap(async (req, res) => {
  ok(res, await listCustomers(await query.validateAsync(req.query)));
});
export const getFounderCustomer = wrap(async (req, res) => {
  const key = await businessId(req);
  const data = await getSafeCustomerDetails(key);
  if (!data) {
    res
      .status(404)
      .json({ success: false, message: "Customer business not found" });
    return;
  }
  // Deliberate customer-detail reads remain audited; routine refreshes do not.
  await AdminActionLog.create({
    admin: req.user.userId,
    targetBusiness: key,
    action: "view_customer",
    message: "Admin customer snapshot viewed",
  });
  ok(res, data);
});
export const updateReportingProfile = wrap(async (req, res) => {
  const key = await businessId(req);
  const value = await profileSchema.validateAsync(req.body);
  if (!(await exists(key, res))) return;
  const before = await AdminReportingProfile.findOne({ business: key }).lean();
  const record = await AdminReportingProfile.findOneAndUpdate(
    { business: key },
    { $set: { ...value, updatedBy: req.user.userId } },
    { upsert: true, returnDocument: "after", runValidators: true },
  );
  if (value.excluded !== undefined)
    await AdminBusinessReport.updateOne(
      { business: key },
      { $set: { excluded: value.excluded } },
    );
  await AdminActionLog.create({
    admin: req.user.userId,
    targetBusiness: key,
    action: "update_reporting_profile",
    message: "Updated reporting classification or founder follow-up",
    metadata: {
      before: before
        ? {
            excluded: before.excluded,
            acquisitionSource: before.acquisitionSource,
            cancellationReason: before.cancellationReason,
            nextAction: before.nextAction,
            followUpAt: before.followUpAt,
          }
        : null,
      after: value,
    },
  });
  await invalidate(key);
  ok(res, record);
});
export const saveReportingCost = wrap(async (req, res) => {
  const key = await businessId(req);
  const value = await costSchema.validateAsync(req.body);
  if (!(await exists(key, res))) return;
  if (value.throughDate.toISOString().slice(0, 7) !== value.period) {
    res.status(400).json({
      success: false,
      message: "Cost cutoff must be in the selected month",
    });
    return;
  }
  const before = await AdminCostRecord.findOne({
    business: key,
    period: value.period,
    category: value.category,
  }).lean();
  const record = await AdminCostRecord.findOneAndUpdate(
    { business: key, period: value.period, category: value.category },
    { $set: { ...value, updatedBy: req.user.userId } },
    { upsert: true, returnDocument: "after", runValidators: true },
  );
  await AdminActionLog.create({
    admin: req.user.userId,
    targetBusiness: key,
    action: "update_reporting_cost",
    message: "Updated monthly reporting cost",
    metadata: {
      before: before
        ? {
            amountCents: before.amountCents,
            basis: before.basis,
            reference: before.reference,
          }
        : null,
      after: value,
    },
  });
  await invalidate(key);
  ok(res, record);
});

const expenseSchema = Joi.object({
  provider: Joi.string()
    .valid(...EXPENSE_PROVIDERS)
    .required(),
  period: Joi.string()
    .pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
    .required(),
  amountCents: Joi.number().integer().min(0).max(100000000).required(),
  basis: Joi.string().valid("estimated", "reconciled").required(),
  fixedMonthly: Joi.boolean().default(true),
  recurring: Joi.boolean().default(false),
  budgetCents: Joi.number()
    .integer()
    .min(0)
    .max(100000000)
    .allow(null)
    .default(null),
  reference: Joi.string().trim().min(1).max(200).required(),
});
export const saveCompanyExpense = wrap(async (req, res) => {
  const value = await expenseSchema.validateAsync(req.body);
  if (value.period > new Date().toISOString().slice(0, 7)) {
    res.status(400).json({
      success: false,
      message: "Choose the current month or an earlier month",
    });
    return;
  }
  const { recurring, budgetCents, ...expense } = value;
  const before = await AdminCompanyExpense.findOne({
    provider: value.provider,
    period: value.period,
    entrySource: "manual",
  }).lean();
  const record = await AdminCompanyExpense.findOneAndUpdate(
    { provider: value.provider, period: value.period, entrySource: "manual" },
    {
      $set: {
        ...expense,
        complete: true,
        throughDate: new Date(),
        syncedAt: new Date(),
        updatedBy: req.user.userId,
      },
    },
    { upsert: true, returnDocument: "after", runValidators: true },
  );
  await AdminExpenseRule.updateOne(
    { provider: value.provider },
    {
      $set: {
        enabled: recurring,
        amountCents: value.amountCents,
        budgetCents,
        effectiveFrom: value.period,
        reference: value.reference,
        updatedBy: req.user.userId,
      },
    },
    { upsert: true },
  );
  await AdminActionLog.create({
    admin: req.user.userId,
    action: "update_company_expense",
    message: `Updated ${value.provider} monthly company expense`,
    metadata: {
      before: before
        ? { amountCents: before.amountCents, period: before.period }
        : null,
      after: value,
    },
  });
  await Promise.all(
    [7, 30, 90].map((days) => deleteScaleCacheKey(`admin:founder:v1:${days}`)),
  );
  ok(res, record);
});
export const refreshCompanyExpenses = wrap(async (req, res) => {
  await AdminReportingState.updateOne(
    { _id: "company-cost-sync" },
    { $set: { "data.nextAt": new Date(0) } },
    { upsert: true },
  );
  await AdminCompanyExpense.updateMany(
    { entrySource: "provider" },
    { $unset: { lastAttemptAt: 1 } },
  );
  await AdminActionLog.create({
    admin: req.user.userId,
    action: "refresh_company_expenses",
    message: "Queued read-only provider expense synchronization",
  });
  ok(res, { queued: true });
});
export const removeExpenseOverride = wrap(async (req, res) => {
  const { provider, period } = await Joi.object({
    provider: Joi.string()
      .valid(...EXPENSE_PROVIDERS)
      .required(),
    period: Joi.string()
      .pattern(/^\d{4}-(0[1-9]|1[0-2])$/)
      .required(),
  }).validateAsync(req.params);
  const before = await AdminCompanyExpense.findOne({
    provider,
    period,
    entrySource: "manual",
  }).lean();
  await AdminActionLog.create({
    admin: req.user.userId,
    action: "remove_expense_override",
    message: "Restored automatic expense reporting",
    metadata: { provider, period, before },
  });
  await AdminCompanyExpense.deleteOne({
    provider,
    period,
    entrySource: "manual",
  });
  await AdminExpenseRule.updateOne({ provider }, { $set: { enabled: false } });
  await Promise.all(
    [7, 30, 90].map((days) => deleteScaleCacheKey(`admin:founder:v1:${days}`)),
  );
  ok(res, { removed: true });
});
