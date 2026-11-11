import {
  BALANCE_PROVIDERS,
  queueBalanceSync,
} from "../../services/admin/providerBalances.service.js";

import { EXPENSE_PROVIDERS } from "../../services/admin/companyExpenses.service.js";

import Joi from "joi";

import Business from "../../models/business.js";

import AdminActionLog from "../../models/adminActionLog.js";

import {
  AdminReportingProfile,
  AdminBusinessReport,
  AdminCostRecord,
  AdminCompanyExpense,
  AdminExpenseRule,
  AdminReportingState,
} from "../../models/adminReporting.js";

import {
  founderOverview,
  listCustomers,
  getSafeCustomerDetails,
} from "../../services/admin/founderReporting.service.js";

import { COST_CATEGORIES } from "../../services/admin/reportingPolicy.js";

import { deleteScaleCacheKey } from "../../services/scaleCache.service.js";

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
const balanceSchema = Joi.object({
  provider: Joi.string()
    .valid(...BALANCE_PROVIDERS)
    .required(),
  kind: Joi.string().valid("prepaid", "amount_due", "payout").required(),
  amountCents: Joi.number().integer().min(-100000000).max(100000000).required(),
  pendingCents: Joi.number()
    .integer()
    .min(-100000000)
    .max(100000000)
    .allow(null)
    .default(null),
  asOf: Joi.date().iso().max("now").required(),
  dueAt: Joi.date().iso().allow(null).default(null),
  thresholdCents: Joi.number().integer().min(0).max(100000000).default(1000),
  reference: Joi.string().trim().min(1).max(200).required(),
});
const clearBalanceCache = () =>
  Promise.all(
    [7, 30, 90].map((days) => deleteScaleCacheKey(`admin:founder:v1:${days}`)),
  );

export { founderOverview, listCustomers, ok, query, wrap, AdminActionLog, businessId, getSafeCustomerDetails, AdminBusinessReport, AdminReportingProfile, exists, invalidate, profileSchema, AdminCostRecord, costSchema, AdminCompanyExpense, AdminExpenseRule, deleteScaleCacheKey, expenseSchema, AdminReportingState, queueBalanceSync, EXPENSE_PROVIDERS, Joi, balanceSchema, clearBalanceCache, BALANCE_PROVIDERS };
