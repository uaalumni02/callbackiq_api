import { AdminActionLog, AdminCompanyExpense, AdminExpenseRule, AdminReportingState, EXPENSE_PROVIDERS, Joi, deleteScaleCacheKey, expenseSchema, ok, queueBalanceSync, wrap } from './context.js';

const saveCompanyExpense = wrap(async (req, res) => {
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

const refreshCompanyExpenses = wrap(async (req, res) => {
  await queueBalanceSync();
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

const removeExpenseOverride = wrap(async (req, res) => {
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

export { saveCompanyExpense, refreshCompanyExpenses, removeExpenseOverride };
