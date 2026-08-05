import crypto from "crypto";

import SmsContactDisclosure from "../models/smsContactDisclosure.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const leaseMs = () =>
  Math.max(60_000, Number(process.env.SMS_DISCLOSURE_LEASE_MS) || 15 * 60_000);

const excludedSource = (source) =>
  ["compliance", "inbound_sms_command"].includes(String(source || ""));

export const claimSmsContactDisclosure = async ({
  businessId,
  phone,
  source,
  requireOptOutDisclosure = false,
  operationKey = "",
  now = new Date(),
}) => {
  if (requireOptOutDisclosure || source === "missed_call_recovery") {
    return { append: true, forced: true, claim: null };
  }
  if (excludedSource(source) || process.env.NODE_ENV === "test") {
    return { append: false, forced: false, claim: null };
  }
  if (
    String(process.env.SMS_ENFORCE_FIRST_CONTACT_DISCLOSURE || "true").toLowerCase() ===
    "false"
  ) {
    return { append: false, forced: false, claim: null };
  }

  const ownerToken = crypto.randomUUID();
  const normalizedOperationKey = String(operationKey || "").slice(0, 240);
  const pending = {
    ownerToken,
    operationKey: normalizedOperationKey,
    state: "pending",
    leaseExpiresAt: new Date(now.getTime() + leaseMs()),
    purgeAt: new Date(now.getTime() + 365 * DAY_MS),
  };
  const existing = await SmsContactDisclosure.findOne({ business: businessId, phone });
  if (existing?.state === "disclosed") {
    return { append: false, forced: false, claim: null, disclosed: true };
  }
  if (existing?.state === "pending" && existing.leaseExpiresAt > now) {
    if (
      normalizedOperationKey &&
      existing.operationKey &&
      normalizedOperationKey === existing.operationKey
    ) {
      return { append: true, forced: false, claim: existing, replayed: true };
    }
    // A concurrent first contact also includes the disclosure for legal safety,
    // but it never receives the first worker's owner token and therefore cannot
    // release or commit that worker's claim.
    return { append: true, forced: false, claim: null, concurrent: true };
  }
  if (existing) {
    const reacquired = await SmsContactDisclosure.findOneAndUpdate(
      {
        _id: existing._id,
        state: "pending",
        leaseExpiresAt: { $lte: now },
      },
      { $set: pending },
      { returnDocument: "after" },
    );
    if (reacquired?.ownerToken === ownerToken) {
      return { append: true, forced: false, claim: reacquired };
    }
    const winner = await SmsContactDisclosure.findById(existing._id);
    return {
      append: winner?.state !== "disclosed",
      forced: false,
      claim: null,
      concurrent: true,
    };
  }
  try {
    const claim = await SmsContactDisclosure.create({
      business: businessId,
      phone,
      ...pending,
    });
    return { append: true, forced: false, claim };
  } catch (error) {
    if (Number(error?.code) !== 11000) throw error;
    const winner = await SmsContactDisclosure.findOne({ business: businessId, phone });
    return {
      append: winner?.state !== "disclosed",
      forced: false,
      claim: null,
      concurrent: true,
    };
  }
};

export const commitSmsContactDisclosure = async ({
  claim,
  businessId,
  phone,
  operationKey = "",
  providerMessageId = "",
}) => {
  const disclosed = {
    state: "disclosed",
    disclosedAt: new Date(),
    providerMessageId,
    leaseExpiresAt: new Date(Date.now() + 365 * DAY_MS),
    purgeAt: new Date(Date.now() + 365 * DAY_MS),
  };
  if (claim?._id && claim.state !== "disclosed") {
    const committed = await SmsContactDisclosure.findOneAndUpdate(
      {
        _id: claim._id,
        state: "pending",
        ownerToken: claim.ownerToken,
      },
      { $set: disclosed },
      { returnDocument: "after" },
    );
    if (committed) return committed;
  }
  if (!businessId || !phone) return claim?.state === "disclosed" ? claim : null;
  return SmsContactDisclosure.findOneAndUpdate(
    { business: businessId, phone },
    {
      $set: disclosed,
      $setOnInsert: {
        business: businessId,
        phone,
        ownerToken: crypto.randomUUID(),
        operationKey: String(operationKey || "").slice(0, 240),
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

export const releaseSmsContactDisclosure = async ({ claim }) => {
  if (!claim?._id || claim.state === "disclosed") return { deletedCount: 0 };
  return SmsContactDisclosure.deleteOne({
    _id: claim._id,
    state: "pending",
    ownerToken: claim.ownerToken,
  });
};

export const sweepExpiredSmsContactDisclosures = ({ now = new Date() } = {}) =>
  SmsContactDisclosure.deleteMany({ state: "pending", leaseExpiresAt: { $lte: now } });

export default {
  claimSmsContactDisclosure,
  commitSmsContactDisclosure,
  releaseSmsContactDisclosure,
  sweepExpiredSmsContactDisclosures,
};
