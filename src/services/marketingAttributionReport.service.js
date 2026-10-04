import mongoose from "mongoose";
import { canonicalLeadValueStages } from "./valuation/valuationReport.js";
import CallLog from "../models/callLog.js";
import Lead from "../models/lead.js";
import MarketingSource from "../models/marketingSource.js";

export const getAttributionReport = async ({
  businessId,
  start = null,
  end = null,
}) => {
  const createdAt = {};
  if (start) createdAt.$gte = new Date(start);
  if (end) createdAt.$lte = new Date(end);

  const dateFilter =
    Object.keys(createdAt).length > 0
      ? { createdAt }
      : {};

  const [sources, calls] = await Promise.all([
    MarketingSource.find({
      business: businessId,
    }).lean(),
    CallLog.find({
      business: businessId,
      deletedAt: null,
      marketingSource: { $ne: null },
      ...dateFilter,
    }, { marketingSource: 1, lead: 1, from: 1, disposition: 1, recovered: 1 }).lean(),
  ]);

  const leadIds = [
    ...new Set(
      calls
        .map((call) => String(call.lead || ""))
        .filter(Boolean),
    ),
  ];

  const sourceObjectIds = sources.map(source => source._id);
  const leads = (leadIds.length || sourceObjectIds.length)
    ? await Lead.aggregate([
        { $match: { business: new mongoose.Types.ObjectId(String(businessId)), $or: [
          { _id: { $in: leadIds.map(id => new mongoose.Types.ObjectId(id)) } },
          { firstMarketingSource: { $in: sourceObjectIds }, ...dateFilter },
        ] } },
        ...canonicalLeadValueStages(),
      ])
    : [];

  // Acquisition credit is write-once, matching Lead.firstMarketingSource.
  // Calls remain per source; a lead and its value belong to only one source.
  const sourceIds = new Set(sources.map(source => String(source._id)));
  const callsBySource = new Map();
  for (const call of calls) {
    const sourceId = String(call.marketingSource);
    if (!sourceIds.has(sourceId)) continue;
    if (!callsBySource.has(sourceId)) callsBySource.set(sourceId, []);
    callsBySource.get(sourceId).push(call);
  }
  // The query includes call-linked leads plus direct first-source leads in this cohort.
  const eligibleLeads = leads;
  const legacyIds = eligibleLeads
    .filter(lead => !sourceIds.has(String(lead.firstMarketingSource || "")))
    .map(lead => lead._id);
  // Resolve legacy acquisition across all history, not just the report window.
  // Retained soft-deleted calls are evidence, but never increase visible calls.
  const earliestCalls = legacyIds.length ? await CallLog.aggregate([
    { $match: {
      business: new mongoose.Types.ObjectId(String(businessId)),
      lead: { $in: legacyIds },
      marketingSource: { $in: sources.map(source => source._id) },
    } },
    { $sort: { createdAt: 1, _id: 1 } },
    { $group: { _id: "$lead", source: { $first: "$marketingSource" } } },
  ]) : [];
  const legacySource = new Map(earliestCalls.map(call => [String(call._id), String(call.source)]));
  const leadsBySource = new Map();
  for (const lead of eligibleLeads) {
    const first = String(lead.firstMarketingSource || "");
    const sourceId = sourceIds.has(first) ? first : legacySource.get(String(lead._id));
    if (!sourceId) continue;
    if (!leadsBySource.has(sourceId)) leadsBySource.set(sourceId, []);
    leadsBySource.get(sourceId).push(lead);
  }

  return sources.filter(source => source.status !== "archived" ||
    callsBySource.has(String(source._id)) || leadsBySource.has(String(source._id))
  ).map((source) => {
    const sourceId = String(source._id);
    const sourceCalls = callsBySource.get(sourceId) || [];
    const uniqueCallers = new Set(sourceCalls.map(call => call.from).filter(Boolean));
    const linkedLeads = leadsBySource.get(sourceId) || [];

    const bookedJobs = linkedLeads.filter(
      (lead) => lead.status === "booked",
    );

    const estimatedRevenue = bookedJobs.reduce(
      (total, lead) =>
        total + (lead._verifiedValue ?? 0),
      0,
    );

    const actualRevenue = linkedLeads.reduce(
      (total, lead) =>
        total + (Number(lead.actualRevenue) || 0),
      0,
    );

    const spend = Number(source.monthlySpend) || 0;

    return {
      sourceId: String(source._id),
      sourceName: source.name,
      channel: source.channel,
      campaign: source.campaign,
      spend,
      totalCalls: sourceCalls.length,
      uniqueCallers: uniqueCallers.size,
      answered: sourceCalls.filter(
        (call) =>
          call.disposition === "answered_by_business",
      ).length,
      missed: sourceCalls.filter((call) =>
        ["missed", "busy", "no_answer", "failed"].includes(
          call.disposition,
        ),
      ).length,
      recovered: sourceCalls.filter(
        (call) => call.recovered === true,
      ).length,
      leads: linkedLeads.length,
      qualifiedLeads: linkedLeads.filter(
        (lead) =>
          lead.serviceEligibility?.decision !== "unsupported" && (Number(lead.leadQualityScore) || 0) >= 60,
      ).length,
      bookedJobs: bookedJobs.length,
      estimatedRevenue,
      actualRevenue,
      costPerLead:
        linkedLeads.length > 0
          ? spend / linkedLeads.length
          : null,
      costPerBookedJob:
        bookedJobs.length > 0
          ? spend / bookedJobs.length
          : null,
      roas:
        spend > 0
          ? actualRevenue / spend
          : null,
    };
  });
};

export default { getAttributionReport };
