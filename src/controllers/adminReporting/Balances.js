import { AdminActionLog, AdminReportingState, BALANCE_PROVIDERS, Joi, balanceSchema, clearBalanceCache, ok, queueBalanceSync, wrap } from './context.js';

const saveProviderBalance = wrap(async (req, res) => {
  const value = await balanceSchema.validateAsync(req.body);
  const data = {
    kind: value.kind,
    amounts: [
      {
        currency: "usd",
        amountCents: value.amountCents,
        ...(value.kind === "payout"
          ? { pendingCents: value.pendingCents }
          : {}),
      },
    ],
    asOf: value.asOf,
    dueAt: value.kind === "amount_due" ? value.dueAt : null,
    thresholdCents: value.thresholdCents,
    reference: value.reference,
    scope: "Manually verified USD balance",
    updatedBy: req.user.userId,
  };
  const id = `provider-balance:${value.provider}:manual`;
  const before = await AdminReportingState.findById(id).lean();
  await AdminReportingState.updateOne(
    { _id: id },
    { $set: { data } },
    { upsert: true },
  );
  await AdminActionLog.create({
    admin: req.user.userId,
    action: "update_provider_balance",
    message: `Recorded ${value.provider} account balance`,
    metadata: {
      provider: value.provider,
      before: before?.data || null,
      after: data,
    },
  });
  await clearBalanceCache();
  ok(res, { saved: true });
});

const removeProviderBalance = wrap(async (req, res) => {
  const provider = await Joi.string()
    .valid(...BALANCE_PROVIDERS)
    .required()
    .validateAsync(req.params.provider);
  const before = await AdminReportingState.findOneAndDelete({
    _id: `provider-balance:${provider}:manual`,
  }).lean();
  await AdminActionLog.create({
    admin: req.user.userId,
    action: "remove_provider_balance",
    message: `Removed ${provider} manual balance`,
    metadata: { provider, before: before?.data || null },
  });
  await clearBalanceCache();
  ok(res, { removed: true });
});

const refreshProviderBalances = wrap(async (req, res) => {
  await queueBalanceSync();
  await AdminActionLog.create({
    admin: req.user.userId,
    action: "refresh_provider_balances",
    message: "Queued read-only balance refresh",
  });
  ok(res, { queued: true });
});

export { saveProviderBalance, removeProviderBalance, refreshProviderBalances };
