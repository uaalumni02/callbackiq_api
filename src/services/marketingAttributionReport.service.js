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
      status: { $ne: "archived" },
    }).lean(),
    CallLog.find({
      business: businessId,
      deletedAt: null,
      marketingSource: { $ne: null },
      ...dateFilter,
    }).lean(),
  ]);

  const leadIds = [
    ...new Set(
      calls
        .map((call) => String(call.lead || ""))
        .filter(Boolean),
    ),
  ];

  const leads = leadIds.length
    ? await Lead.aggregate([
        { $match: { _id: { $in: leadIds.map(id => new mongoose.Types.ObjectId(id)) }, business: new mongoose.Types.ObjectId(String(businessId)) } },
        ...canonicalLeadValueStages(),
      ])
    : [];

  const leadMap = new Map(
    leads.map((lead) => [String(lead._id), lead]),
  );

  return sources.map((source) => {
    const sourceCalls = calls.filter(
      (call) =>
        String(call.marketingSource) === String(source._id),
    );

    const uniqueCallers = new Set(
      sourceCalls.map((call) => call.from).filter(Boolean),
    );

    const linkedLeads = [
      ...new Map(
        sourceCalls
          .map((call) => [
            String(call.lead || ""),
            leadMap.get(String(call.lead || "")),
          ])
          .filter(([, lead]) => Boolean(lead)),
      ).values(),
    ];

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
