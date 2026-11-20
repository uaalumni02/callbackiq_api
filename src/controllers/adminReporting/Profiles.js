import AdminActionLog from "../../models/adminActionLog.js";
import { AdminBusinessReport, AdminCostRecord, AdminReportingProfile } from "../../models/adminReporting.js";
import { businessId, costSchema, exists, invalidate, ok, profileSchema, wrap } from "./helpers.js";

const updateReportingProfile = wrap(async (req, res) => {
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

const saveReportingCost = wrap(async (req, res) => {
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

export { updateReportingProfile, saveReportingCost };
