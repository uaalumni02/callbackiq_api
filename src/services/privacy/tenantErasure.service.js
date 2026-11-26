import { eraseTenantProviderBudget } from '../budgets/providerBudget.service.js';
import ReleaseIntent from "../../models/trackingNumberReleaseIntent.js";
import crypto from "node:crypto";
import mongoose from "mongoose";
import Business from "../../models/business.js";
import User from "../../models/user.js";
import Connection from "../../models/integrationConnection.js";
import DisconnectIntent from "../../models/integrationDisconnectIntent.js";
import { disconnectGoogleAccount } from "../integrations/googleDisconnect.service.js";
import Receipt from "../../models/tenantDeletionReceipt.js";
import BillingRecord from "../../models/retainedBillingRecord.js";
import { numericSetting } from "../../config/numericSettings.js";
const pending = () =>
  Object.assign(
    new Error(
      "Google grant revocation must be verified before erasing this account. Cleanup will retry.",
    ),
    { code: "BUSINESS_DELETION_GOOGLE_PENDING", statusCode: 503 },
  );
/** Disables and durably revokes all Google grants; incomplete external outcomes block final erasure. */
export async function revokeTenantGrants(businessId) {
  const connection = await Connection.findOne({
    business: businessId,
    provider: "google_calendar",
  }).select("+accessTokenEncrypted +refreshTokenEncrypted");
  if (
    connection &&
    (connection.status !== "disconnected" ||
      connection.accessTokenEncrypted ||
      connection.refreshTokenEncrypted)
  )
    await disconnectGoogleAccount(connection);
  if (
    await DisconnectIntent.exists({
      business: businessId,
      state: { $ne: "completed" },
    })
  )
    throw pending();
}
/** Enumerates physical collections so future tenant children are erased without a fragile model allowlist. */
export async function tenantErasurePlan(business) {
  const collections = (
    await mongoose.connection.db
      .listCollections({}, { nameOnly: true })
      .toArray()
  )
    .map((row) => row.name)
    .filter(
      (name) =>
        !name.startsWith("system.") &&
        ![
          Receipt.collection.name,
          BillingRecord.collection.name,
          Business.collection.name,
          User.collection.name,
        ].includes(name),
    );
  const owner = await User.findById(business.owner).select("role").lean();
  const other = await Business.exists({
    owner: business.owner,
    _id: { $ne: business._id },
  });
  return {
    collections,
    eraseOwner: Boolean(owner && owner.role !== "admin" && !other),
    receiptId: crypto.randomUUID(),
  };
}
const anonymizeReleaseReceipts = async (business, session) => {
  // Completed release receipts prove that a billable number was removed, without retaining its owner/resource identity.
  const releases = await ReleaseIntent.find({
    business: business._id,
    status: { $in: ["completed", "superseded"] },
  })
    .session(session)
    .select("+providerSid +providerAccountSid")
    .lean();
  for (const release of releases) {
    const hashed = (value) =>
      "erased:" +
      crypto
        .createHash("sha256")
        .update(String(value || ""))
        .digest("hex");
    await ReleaseIntent.collection.updateOne(
      { _id: release._id, business: business._id },
      {
        $set: {
          business: new mongoose.Types.ObjectId(),
          providerSid: hashed(release.providerSid),
          providerAccountSid: hashed(release.providerAccountSid),
          authorization: { kind: "business_deletion" },
          claimToken: "",
          purgeAt: new Date(
            Date.now() +
              numericSetting("PILOT_BILLING_RETENTION_DAYS") * 86400000,
          ),
        },
      },
      { session },
    );
  }
};
const retainBillingReference = async (subscription, receiptId, session) => {
  if (subscription?.stripeCustomerId || subscription?.stripeSubscriptionId) {
    const fields = Object.fromEntries(
      [
        "stripeCustomerId",
        "stripeSubscriptionId",
        "plan",
        "priceMonthly",
        "currentPeriodStart",
        "currentPeriodEnd",
      ].map((key) => [key, subscription[key]]),
    );
    await BillingRecord.create(
      [
        {
          _id: receiptId,
          ...fields,
          closedAt: new Date(),
          purgeAt: new Date(
            Date.now() +
              numericSetting("PILOT_BILLING_RETENTION_DAYS") * 86400000,
          ),
        },
      ],
      { session },
    );
  }
};
/** Erases tenant references/PII transactionally; retains only minimal billing references and a non-identifying count receipt. */
export async function eraseTenantChildren({
  business,
  subscription,
  plan,
  session,
}) {
  let recordsErased = 0,
    collectionsErased = 0;
  const budget = await eraseTenantProviderBudget({ businessId: business._id, mongoSession: session });
  recordsErased += budget.recordsErased; collectionsErased += budget.collectionsErased;
  await anonymizeReleaseReceipts(business, session);
  for (const name of plan.collections) {
    const predicates = ["business", "businessId", "targetBusiness"].flatMap(
      (key) => [{ [key]: business._id }, { [key]: String(business._id) }],
    );
    if (plan.eraseOwner)
      predicates.push(
        ...["owner", "user", "userId"].flatMap((key) => [
          { [key]: business.owner },
          { [key]: String(business.owner) },
        ]),
      );
    const result = await mongoose.connection.db
      .collection(name)
      .deleteMany({ $or: predicates }, { session });
    recordsErased += result.deletedCount;
    collectionsErased += Number(result.deletedCount > 0);
  }
  if (plan.eraseOwner) {
    const result = await User.deleteOne(
      { _id: business.owner, role: { $ne: "admin" } },
      { session },
    );
    recordsErased += result.deletedCount;
  }
  await retainBillingReference(subscription, plan.receiptId, session);
  await Receipt.create(
    [
      {
        _id: plan.receiptId,
        completedAt: new Date(),
        collectionsErased,
        recordsErased,
        purgeAt: new Date(
          Date.now() +
            numericSetting("PILOT_ERASURE_RECEIPT_RETENTION_DAYS") * 86400000,
        ),
      },
    ],
    { session },
  );
  return { receiptId: plan.receiptId, collectionsErased, recordsErased };
}
