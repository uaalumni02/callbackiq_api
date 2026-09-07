import mongoose from "mongoose";
const { Schema } = mongoose;
const model = (name, definition, indexes = []) => {
  const schema = new Schema(definition, { timestamps: true });
  indexes.forEach(([keys, options]) => schema.index(keys, options));
  return mongoose.models[name] || mongoose.model(name, schema);
};
export const AdminBusinessReport = model(
  "AdminBusinessReport",
  {
    business: { type: Schema.Types.ObjectId, required: true },
    excluded: { type: Boolean, default: false },
    name: String,
    search: String,
    refreshedAt: Date,
    nextRefreshAt: Date,
    leaseUntil: Date,
    leaseToken: String,
    failureCode: String,
    firstObservedAt: Date,
    firstReadyObservedAt: Date,
    blockerObservedAt: Date,
    blockerCode: String,
    payload: Schema.Types.Mixed,
  },
  [
    [{ business: 1 }, { unique: true }],
    [{ nextRefreshAt: 1, leaseUntil: 1 }],
    [{ excluded: 1, name: 1, business: 1 }],
  ],
);
export const AdminReportingProfile = model(
  "AdminReportingProfile",
  {
    business: { type: Schema.Types.ObjectId, required: true },
    excluded: { type: Boolean, default: false },
    exclusionReason: String,
    acquisitionSource: String,
    cancellationReason: String,
    nextAction: String,
    followUpAt: Date,
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  [[{ business: 1 }, { unique: true }]],
);
export const AdminCostRecord = model(
  "AdminCostRecord",
  {
    business: { type: Schema.Types.ObjectId, required: true },
    period: { type: String, required: true },
    category: {
      type: String,
      enum: [
        "sms",
        "voice",
        "ai",
        "numbers",
        "provider_other",
        "processing",
        "support",
      ],
      required: true,
    },
    amountCents: { type: Number, min: 0, required: true },
    basis: { type: String, enum: ["estimated", "reconciled"], required: true },
    currency: { type: String, enum: ["usd"], default: "usd" },
    throughDate: { type: Date, required: true },
    supportMinutes: { type: Number, min: 0, default: 0 },
    reference: { type: String, maxlength: 200, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  [[{ business: 1, period: 1, category: 1 }, { unique: true }]],
);
export const AdminBillingFact = model(
  "AdminBillingFact",
  {
    business: { type: Schema.Types.ObjectId, required: true },
    invoiceId: { type: String, required: true },
    subscriptionId: String,
    currency: String,
    livemode: Boolean,
    status: String,
    amountPaidCents: Number,
    amountRemainingCents: Number,
    allocatableCents: Number,
    created: Date,
    paidAt: Date,
    dueAt: Date,
    observedAt: Date,
    periodStart: Date,
    periodEnd: Date,
    recurring: Boolean,
  },
  [
    [{ invoiceId: 1 }, { unique: true }],
    [{ business: 1, paidAt: 1 }],
    [{ business: 1, created: 1 }],
  ],
);
export const AdminReportingState = model("AdminReportingState", {
  _id: String,
  data: Schema.Types.Mixed,
});
export const AdminRevenueSnapshot = model(
  "AdminRevenueSnapshot",
  {
    business: { type: Schema.Types.ObjectId, required: true },
    day: String,
    mrrCents: Number,
    paid: Boolean,
    status: String,
    currency: String,
  },
  [[{ business: 1, day: 1 }, { unique: true }], [{ day: 1, business: 1 }]],
);
export const AdminCompanyExpense = model(
  "AdminCompanyExpense",
  {
    provider: {
      type: String,
      enum: ["twilio", "openai", "stripe", "ngrok", "hosting", "other"],
      required: true,
    },
    period: { type: String, required: true },
    entrySource: { type: String, enum: ["provider", "manual"], required: true },
    amountCents: Number,
    currency: { type: String, default: "usd" },
    basis: {
      type: String,
      enum: ["provider_reported", "reconciled", "estimated"],
      required: true,
    },
    fixedMonthly: { type: Boolean, default: false },
    complete: { type: Boolean, default: false },
    throughDate: Date,
    providerAsOf: String,
    syncedAt: Date,
    lastAttemptAt: Date,
    errorCode: String,
    reference: String,
    scope: String,
    details: Schema.Types.Mixed,
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  [
    [{ provider: 1, period: 1, entrySource: 1 }, { unique: true }],
    [{ period: 1 }],
  ],
);
export const AdminExpenseRule = model(
  "AdminExpenseRule",
  {
    provider: { type: String, required: true },
    amountCents: Number,
    effectiveFrom: String,
    budgetCents: Number,
    enabled: Boolean,
    reference: String,
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  [[{ provider: 1 }, { unique: true }]],
);
