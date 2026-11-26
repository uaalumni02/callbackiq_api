import { numericSetting } from '../../config/numericSettings.js';
import crypto from "node:crypto";
import mongoose from "mongoose";
import Counter from "../../models/providerBudgetCounter.js";
import Reservation from "../../models/providerBudgetReservation.js";
import Override from "../../models/providerBudgetOverride.js";
import {
  pilotBudget,
  providerDispatchPaused,
} from "../../config/pilotBudgets.js";
const digest = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
const failure = (code, message) =>
  Object.assign(new Error(message), { code, statusCode: 429 });
const scopeFor = (businessId) => digest(`pilot:${businessId}`);
const bucketRows = (scope, metric, now, limits) => [
  [`${scope}:${metric}:day:${now.toISOString().slice(0, 10)}`, limits.daily],
  [`${scope}:${metric}:month:${now.toISOString().slice(0, 7)}`, limits.monthly],
  [`fleet:${metric}:day:${now.toISOString().slice(0, 10)}`, limits.fleetDaily],
  [
    `fleet:${metric}:month:${now.toISOString().slice(0, 7)}`,
    limits.fleetMonthly,
  ],
];
const reserveBucket = async (key, limit, amount, purgeAt, session) => {
  await Counter.updateOne(
    { _id: key },
    { $setOnInsert: { used: 0, purgeAt } },
    { upsert: true, session },
  );
  const result = await Counter.updateOne(
    { _id: key, $expr: { $lte: [{ $add: ["$used", amount] }, limit] } },
    { $inc: { used: amount } },
    { session },
  );
  if (!result.modifiedCount)
    throw failure(
      "PROVIDER_BUDGET_EXHAUSTED",
      "The pilot provider allowance is exhausted.",
    );
};
const reserveInSession = async (
  { businessId, metric, amount, key, now },
  session,
) => {
  const scope = scopeFor(businessId),
    id = digest(`${scope}:${metric}:${key}`);
  const existing = await Reservation.findById(id).session(session).lean();
  if (existing) {
    if (existing.amount !== amount)
      throw failure(
        "PROVIDER_BUDGET_KEY_CONFLICT",
        "A provider operation changed its reserved amount.",
      );
    return { allowed: true, replayed: true };
  }
  const limits = pilotBudget(metric),
    override = await Override.findOne({ business: businessId })
      .session(session)
      .lean();
  for (const type of ["daily", "monthly"])
    if (Number.isInteger(override?.limits?.[metric]?.[type]))
      limits[type] = Math.min(limits[type], override.limits[metric][type]);
  const purgeAt = new Date(now.getTime() + numericSetting("PILOT_PROVIDER_BUDGET_RETENTION_DAYS") * 86400000);
  for (const [bucket, limit] of bucketRows(scope, metric, now, limits))
    await reserveBucket(bucket, limit, amount, purgeAt, session);
  await Reservation.create(
    [
      {
        _id: id,
        scope,
        metric,
        amount,
        purgeAt,
        buckets: bucketRows(scope, metric, now, limits).map(
          ([bucket]) => bucket,
        ),
      },
    ],
    { session },
  );
  return { allowed: true, replayed: false };
};
/** Atomically reserves conservative tenant+fleet usage; failure never authorizes dispatch or partial spend. */
export async function reserveProviderBudget(
  {
    businessId,
    metric,
    amount = 1,
    key,
    now = new Date(),
    mongoSession = null,
  },
  retry = 0,
) {
  if (providerDispatchPaused())
    throw failure(
      "PROVIDER_CIRCUIT_OPEN",
      "Automated provider service is temporarily paused.",
    );
  if (!businessId || !key || !Number.isSafeInteger(amount) || amount < 1)
    throw failure(
      "PROVIDER_BUDGET_CONTEXT_REQUIRED",
      "A valid provider budget identity is required.",
    );
  const input = { businessId, metric, amount, key, now };
  if (mongoSession) return reserveInSession(input, mongoSession);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await reserveInSession(input, session);
    });
    return result;
  } catch (error) {
    if (error.code === 11000 && retry < 3)
      return reserveProviderBudget(input, retry + 1);
    throw error;
  } finally {
    await session.endSession();
  }
}

/** Settles a reserved estimate once from a verified receipt; unknown reservations receive no refund. */
export async function settleProviderBudget({
  businessId,
  metric,
  key,
  actualAmount,
  mongoSession,
}) {
  if (!Number.isSafeInteger(actualAmount) || actualAmount < 0)
    throw new TypeError("A verified nonnegative usage amount is required.");
  const id = digest(`${scopeFor(businessId)}:${metric}:${key}`);
  const previous = await Reservation.findOneAndUpdate(
    { _id: id, state: "reserved" },
    { $set: { state: "settled", actualAmount } },
    { session: mongoSession, returnDocument: "before" },
  );
  if (!previous) return false;
  const difference = actualAmount - previous.amount;
  for (const bucket of previous.buckets || [])
    await Counter.updateOne(
      { _id: bucket },
      [{ $set: { used: { $max: [0, { $add: ["$used", difference] }] } } }],
      { session: mongoSession, updatePipeline: true },
    );
  return true;
}

/** Erases hashed tenant budget children in the caller's erasure transaction; fleet spend is never refunded. */
export async function eraseTenantProviderBudget({ businessId, mongoSession }) {
  if (!businessId || !mongoSession?.inTransaction())
    throw new TypeError(
      "Tenant budget erasure requires the active erasure transaction.",
    );
  const scope = scopeFor(businessId);
  const reservations = await Reservation.deleteMany(
    { scope },
    { session: mongoSession },
  );
  const counters = await Counter.deleteMany(
    { _id: { $regex: `^${scope}:` } },
    { session: mongoSession },
  );
  return {
    recordsErased: reservations.deletedCount + counters.deletedCount,
    collectionsErased:
      Number(reservations.deletedCount > 0) + Number(counters.deletedCount > 0),
  };
}
