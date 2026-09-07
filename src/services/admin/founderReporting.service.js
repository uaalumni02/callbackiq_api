import { companyExpenseSummary } from "./companyExpenses.service.js";
import SmsProcessingJob from "../../models/smsProcessingJob.js";
import BillingAnomaly from "../../models/billingAnomaly.js";
import { syncBusinessBillingReport } from "./billingReporting.service.js";
import mongoose from "mongoose";
import Business from "../../models/business.js";
import User from "../../models/user.js";
import Subscription from "../../models/subscription.js";
import Lead from "../../models/lead.js";
import CallLog from "../../models/callLog.js";
import Message from "../../models/message.js";
import Conversation from "../../models/conversation.js";
import Appointment from "../../models/appointment.js";
import ConversionEvent from "../../models/conversionEvent.js";
import SupportTicket from "../../models/supportTicket.js";
import DemoRequest from "../../models/demoRequest.js";
import IntegrationConnection from "../../models/integrationConnection.js";
import WebhookWork from "../../models/webhookWork.js";
import VoiceUsageLedger from "../../models/voiceUsageLedger.js";
import {
  AdminBusinessReport,
  AdminReportingProfile,
  AdminCostRecord,
  AdminBillingFact,
  AdminReportingState,
  AdminRevenueSnapshot,
} from "../../models/adminReporting.js";
import { buildBusinessReadiness } from "../businessReadiness.service.js";
import { getOrLoadScaleCache } from "../scaleCache.service.js";
import {
  DAY,
  WINDOWS,
  MISSED_STATUSES,
  OWNER_FIELDS,
  BUSINESS_FIELDS,
  SUBSCRIPTION_FIELDS,
  realMatch,
  syntheticMatch,
  rate,
  date,
  inRange,
  billingState,
  readinessState,
  costSummary,
  actionsFor,
} from "./reportingPolicy.js";

const TIMEOUT = 5000;
const sumIf = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });
const aggregate = (Model, pipeline) =>
  Model.aggregate(pipeline).option({ maxTimeMS: TIMEOUT, allowDiskUse: false });
// Exclude linked synthetic leads as well as directly marked records. Only an ID
// leaves the lookup; no transcript or homeowner profile enters reporting rows.
const realStages = (linked = true) => [
  { $match: realMatch() },
  ...(linked
    ? [
        {
          $lookup: {
            from: "leads",
            let: { leadId: "$lead" },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$_id", "$$leadId"] },
                  ...syntheticMatch(),
                },
              },
              { $project: { _id: 1 } },
            ],
            as: "_fixture",
          },
        },
        { $match: { "_fixture.0": { $exists: false } } },
      ]
    : []),
];
const periodCounts = async (
  Model,
  business,
  field,
  group,
  now,
  linked = true,
) => {
  const start = new Date(+now - 180 * DAY);
  const facets = {};
  for (const days of WINDOWS) {
    facets[days] = [
      { $match: { [field]: { $gte: new Date(+now - days * DAY), $lt: now } } },
      { $group: { _id: null, ...group } },
    ];
    facets[`previous${days}`] = [
      {
        $match: {
          [field]: {
            $gte: new Date(+now - 2 * days * DAY),
            $lt: new Date(+now - days * DAY),
          },
        },
      },
      { $group: { _id: null, ...group } },
    ];
  }
  const cohortStages =
    Model === Lead
      ? [
          {
            $lookup: {
              from: "messages",
              let: { leadId: "$_id", businessId: "$business" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ["$lead", "$$leadId"] },
                        { $eq: ["$business", "$$businessId"] },
                      ],
                    },
                    direction: "inbound",
                    createdAt: { $lt: now },
                    ...realMatch(),
                  },
                },
                { $limit: 1 },
                { $project: { _id: 1 } },
              ],
              as: "_replies",
            },
          },
          {
            $lookup: {
              from: "appointments",
              let: { leadId: "$_id", businessId: "$business" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ["$lead", "$$leadId"] },
                        { $eq: ["$business", "$$businessId"] },
                      ],
                    },
                    status: {
                      $nin: ["canceled", "cancelled", "rescheduled", "held"],
                    },
                    confirmedAt: { $ne: null, $lt: now },
                    ...realMatch(),
                  },
                },
                { $limit: 1 },
                { $project: { _id: 1 } },
              ],
              as: "_bookings",
            },
          },
        ]
      : [];
  // All activity queries are tenant-scoped and bounded to 180 days.
  const [result] = await aggregate(Model, [
    { $match: { business, [field]: { $gte: start, $lt: now } } },
    ...realStages(linked),
    ...cohortStages,
    { $facet: facets },
  ]);
  return Object.fromEntries(
    Object.entries(result || {}).map(([key, rows]) => [key, rows[0] || {}]),
  );
};
const getLatest = async (Model, business, field, linked = true) => {
  const rows = await aggregate(Model, [
    { $match: { business, ...realMatch() } },
    { $sort: { [field]: -1 } },
    ...realStages(linked),
    { $limit: 1 },
    { $project: { [field]: 1 } },
  ]);
  return rows[0]?.[field] || null;
};
export const invoiceTotals = (facts, start, end) => {
  const live = facts.filter((f) => f.livemode === true && f.currency === "usd");
  const cashCents = live
    .filter((f) => inRange(f.paidAt, start, end))
    .reduce((s, f) => s + (f.amountPaidCents || 0), 0);
  // A management allocation of paid recurring invoice amounts, not GAAP revenue.
  let allocatedCents = 0,
    allocationComplete = true;
  for (const f of live) {
    const a = date(f.periodStart),
      b = date(f.periodEnd);
    if (f.status !== "paid" || !f.recurring) continue;
    if (!a || !b || b <= a || f.allocatableCents == null) {
      allocationComplete = false;
      continue;
    }
    const overlap = Math.max(0, Math.min(+b, +end) - Math.max(+a, +start));
    allocatedCents += (f.allocatableCents * overlap) / (b - a);
  }
  return {
    cashCents,
    allocatedCents: allocationComplete ? Math.round(allocatedCents) : null,
    overdueCents: live
      .filter(
        (f) => f.status === "open" && date(f.dueAt) && date(f.dueAt) < end,
      )
      .reduce((s, f) => s + (f.amountRemainingCents || 0), 0),
  };
};
export const refreshBusinessReport = async (businessId, now = new Date()) => {
  const business = await Business.findById(businessId)
    .select(BUSINESS_FIELDS)
    .maxTimeMS(TIMEOUT)
    .lean();
  if (!business) {
    await AdminBusinessReport.deleteOne({ business: businessId });
    return null;
  }
  await syncBusinessBillingReport(business._id, { now }).catch(() => null);
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const period = now.toISOString().slice(0, 7);
  const [
    owner,
    sub,
    previous,
    profile,
    facts,
    costs,
    usage,
    readiness,
    calls,
    messages,
    leads,
    bookings,
    completed,
    conversions,
    tickets,
    integrations,
    work,
    lastCallAt,
    lastMessageAt,
    billingCoverage,
    sourceDemo,
  ] = await Promise.all([
    User.findById(business.owner)
      .select(OWNER_FIELDS)
      .maxTimeMS(TIMEOUT)
      .lean(),
    Subscription.findOne({ business: business._id })
      .select(SUBSCRIPTION_FIELDS)
      .maxTimeMS(TIMEOUT)
      .lean(),
    AdminBusinessReport.findOne({ business: business._id }).lean(),
    AdminReportingProfile.findOne({ business: business._id }).lean(),
    AdminBillingFact.find({ business: business._id })
      .select(
        "invoiceId currency livemode status amountPaidCents amountRemainingCents paidAt dueAt periodStart periodEnd recurring allocatableCents",
      )
      .maxTimeMS(TIMEOUT)
      .lean(),
    AdminCostRecord.find({ business: business._id, period }).lean(),
    VoiceUsageLedger.findOne({
      business: business._id,
      periodType: "month",
      periodKey: period,
    })
      .select(
        "completedSeconds openAiInputTokens openAiOutputTokens twilioEstimatedCostCents openAiEstimatedCostCents",
      )
      .lean(),
    buildBusinessReadiness(business, { persist: false }),
    periodCounts(
      CallLog,
      business._id,
      "createdAt",
      {
        total: { $sum: 1 },
        missed: sumIf({
          $and: [
            { $eq: ["$direction", "inbound"] },
            { $in: ["$status", MISSED_STATUSES] },
          ],
        }),
        recoveredMissed: sumIf({
          $and: [
            { $eq: ["$direction", "inbound"] },
            { $in: ["$status", MISSED_STATUSES] },
            { $eq: ["$recovered", true] },
          ],
        }),
        failed: sumIf({ $eq: ["$status", "failed"] }),
      },
      now,
    ),
    periodCounts(
      Message,
      business._id,
      "createdAt",
      {
        total: { $sum: 1 },
        recoveryDelivered: sumIf({
          $and: [
            { $eq: ["$direction", "outbound"] },
            { $eq: ["$status", "delivered"] },
            {
              $in: [
                "$usageCategory",
                ["missed_call_recovery", "voice_fallback"],
              ],
            },
          ],
        }),
        inbound: sumIf({ $eq: ["$direction", "inbound"] }),
        outbound: sumIf({ $eq: ["$direction", "outbound"] }),
        delivered: sumIf({
          $and: [
            { $eq: ["$direction", "outbound"] },
            { $eq: ["$status", "delivered"] },
          ],
        }),
        failed: sumIf({
          $and: [
            { $eq: ["$direction", "outbound"] },
            { $in: ["$status", ["failed", "undelivered"]] },
          ],
        }),
        segments: {
          $sum: {
            $cond: [
              { $eq: ["$direction", "outbound"] },
              { $ifNull: ["$segmentCount", 1] },
              0,
            ],
          },
        },
      },
      now,
    ),
    periodCounts(
      Lead,
      business._id,
      "createdAt",
      {
        total: { $sum: 1 },
        replied: sumIf({ $gt: [{ $size: "$_replies" }, 0] }),
        qualified: sumIf({ $ne: [{ $ifNull: ["$qualifiedAt", null] }, null] }),
        booked: sumIf({ $gt: [{ $size: "$_bookings" }, 0] }),
      },
      now,
      false,
    ),
    periodCounts(
      Appointment,
      business._id,
      "confirmedAt",
      {
        total: sumIf({
          $in: ["$status", ["confirmed", "completed", "no_show"]],
        }),
      },
      now,
    ),
    periodCounts(
      Appointment,
      business._id,
      "completedAt",
      {
        total: sumIf({ $eq: ["$status", "completed"] }),
        actualRevenue: {
          $sum: {
            $cond: [
              { $eq: ["$status", "completed"] },
              { $ifNull: ["$actualRevenue", 0] },
              0,
            ],
          },
        },
        recorded: sumIf({
          $and: [
            { $eq: ["$status", "completed"] },
            { $gt: ["$actualRevenue", 0] },
          ],
        }),
      },
      now,
    ),
    periodCounts(
      ConversionEvent,
      business._id,
      "occurredAt",
      {
        responseCount: sumIf({
          $and: [
            { $eq: ["$type", "first_response"] },
            { $isNumber: "$metadata.responseSeconds" },
          ],
        }),
        responseSeconds: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ["$type", "first_response"] },
                  { $isNumber: "$metadata.responseSeconds" },
                ],
              },
              "$metadata.responseSeconds",
              0,
            ],
          },
        },
      },
      now,
    ),
    aggregate(SupportTicket, [
      {
        $match: {
          business: business._id,
          status: { $in: ["open", "in_progress"] },
        },
      },
      {
        $group: {
          _id: null,
          open: { $sum: 1 },
          high: sumIf({ $eq: ["$priority", "high"] }),
          overdue: sumIf({
            $lt: [
              { $ifNull: ["$lastAdminUpdateAt", "$createdAt"] },
              new Date(+now - 2 * DAY),
            ],
          }),
          oldest: { $min: "$createdAt" },
        },
      },
    ]),
    IntegrationConnection.find({ business: business._id })
      .select("provider status lastErrorAt")
      .lean(),
    aggregate(WebhookWork, [
      {
        $match: {
          business: business._id,
          $or: [
            { status: "dead" },
            { status: "processing", leaseUntil: { $lt: now } },
            {
              status: "queued",
              availableAt: { $lt: new Date(+now - 15 * 60000) },
            },
          ],
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          oldest: { $min: "createdAt" },
        },
      },
    ]),
    getLatest(CallLog, business._id, "createdAt"),
    getLatest(Message, business._id, "createdAt"),
    AdminReportingState.findById(`billing:${business._id}`).lean(),
    DemoRequest.findOne({
      convertedBusiness: business._id,
      status: { $ne: "spam" },
    })
      .select("utmSource source createdAt completedAt")
      .sort({ createdAt: 1 })
      .lean(),
  ]);
  const windows = {};
  for (const key of [...WINDOWS, ...WINDOWS.map((w) => `previous${w}`)]) {
    const c = calls[key] || {},
      m = messages[key] || {},
      l = leads[key] || {},
      b = bookings[key] || {},
      j = completed[key] || {},
      v = conversions[key] || {};
    windows[key] = {
      calls: c.total || 0,
      missedCalls: c.missed || 0,
      recoveredCalls: c.recoveredMissed || 0,
      messages: m.total || 0,
      inboundMessages: m.inbound || 0,
      outboundMessages: m.outbound || 0,
      deliveredMessages: m.delivered || 0,
      recoveryDeliveredMessages: m.recoveryDelivered || 0,
      smsSegments: m.segments || 0,
      leads: l.total || 0,
      repliedLeads: l.replied || 0,
      qualifiedLeads: l.qualified || 0,
      bookedLeads: l.booked || 0,
      bookings: b.total || 0,
      completedJobs: j.total || 0,
      recordedRevenueJobs: j.recorded || 0,
      actualRevenue: j.recorded > 0 ? j.actualRevenue : null,
      recoveryRate: rate(c.recoveredMissed || 0, c.missed || 0),
      leadBookingRate: rate(l.booked || 0, l.total || 0),
      replyRate: rate(l.replied || 0, l.total || 0),
      deliveryRate: rate(m.delivered || 0, m.outbound || 0),
      responseCount: v.responseCount || 0,
      responseSeconds: v.responseSeconds || 0,
      averageResponseSeconds:
        v.responseCount > 0 ? v.responseSeconds / v.responseCount : null,
      smsFailures: m.failed || 0,
      callFailures: c.failed || 0,
    };
  }
  const [smsJobHealth, billingAnomalies] = await Promise.all([
    aggregate(SmsProcessingJob, [
      {
        $match: {
          business: business._id,
          $or: [
            { status: "dead" },
            { status: "processing", leaseExpiresAt: { $lt: now } },
            {
              status: { $in: ["queued", "retry"] },
              availableAt: { $lt: new Date(+now - 15 * 60000) },
            },
          ],
        },
      },
      ...realStages(),
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          oldest: { $min: "createdAt" },
        },
      },
    ]),
    BillingAnomaly.countDocuments({
      business: business._id,
      status: "open",
    }).maxTimeMS(TIMEOUT),
  ]);
  const [appointmentHealth] = await aggregate(Appointment, [
    {
      $match: {
        business: business._id,
        createdAt: { $gte: new Date(+now - 30 * DAY), $lt: now },
      },
    },
    ...realStages(),
    {
      $group: {
        _id: null,
        failures: sumIf({ $eq: ["$status", "failed"] }),
        requested: sumIf({
          $ne: [{ $ifNull: ["$approvalRequestedAt", null] }, null],
        }),
        waiting: sumIf({
          $and: [
            { $eq: ["$status", "held"] },
            { $eq: ["$requiresBusinessApproval", true] },
          ],
        }),
      },
    },
  ]);
  const coverage = billingCoverage?.data || {};
  const billing = billingState(
    {
      ...sub,
      priceMonthly:
        coverage.monthlyCents == null ? null : coverage.monthlyCents / 100,
    },
    facts,
    now,
  );
  const ready = readinessState(business, readiness, previous, now);
  const financialCutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const amounts = invoiceTotals(facts, monthStart, financialCutoff);
  const billingComplete = Boolean(
    coverage.complete && date(coverage.syncedAt) >= new Date(+now - DAY),
  );
  const row = {
    business: {
      _id: business._id,
      businessName: business.businessName,
      businessType: business.businessType,
      isActive: business.isActive,
      createdAt: business.createdAt,
      estimatedJobValue: business.estimatedJobValue,
    },
    owner,
    subscription: sub
      ? { plan: sub.plan, status: sub.status, aiEnabled: sub.aiEnabled }
      : { plan: "none", status: "none" },
    profile: profile
      ? {
          excluded: profile.excluded,
          acquisitionSource: profile.acquisitionSource,
          cancellationReason: profile.cancellationReason,
          nextAction: profile.nextAction,
          followUpAt: profile.followUpAt,
        }
      : {},
    billing: {
      ...billing,
      cashCollectedCents: billingComplete ? amounts.cashCents : null,
      overdueCents: billingComplete ? amounts.overdueCents : null,
      coverage: billingComplete ? "reconciled" : "incomplete",
      currency: "usd",
      financialCutoff,
      revenueBasis: coverage.revenueBasis || "Billing history not reconciled",
      cancellationReason:
        profile?.cancellationReason ||
        coverage.cancellationReason ||
        "Not recorded",
    },
    readiness: ready,
    windows,
    counts: { leads: windows[30].leads, calls: windows[30].calls },
    lastActivityAt:
      [lastCallAt, lastMessageAt]
        .filter(Boolean)
        .sort((a, b) => new Date(b) - new Date(a))[0] || null,
    lastMessageAt,
    cost: costSummary(
      costs,
      usage || {},
      now,
      billingComplete ? amounts.allocatedCents : null,
    ),
    usage: usage
      ? {
          seconds: usage.completedSeconds,
          inputTokens: usage.openAiInputTokens,
          outputTokens: usage.openAiOutputTokens,
        }
      : null,
    source:
      profile?.acquisitionSource ||
      sourceDemo?.utmSource ||
      sourceDemo?.source ||
      "Unattributed",
    health: {
      smsFailures: windows[30].smsFailures,
      callFailures: windows[30].callFailures,
      bookingFailures: appointmentHealth?.failures || 0,
      pendingApprovals: appointmentHealth?.waiting || 0,
      bookingRequests: appointmentHealth?.requested || 0,
      integrationErrors: integrations.filter((i) =>
        ["error", "expired", "reconnect_required"].includes(i.status),
      ).length,
      openTickets: tickets[0]?.open || 0,
      highPriorityTickets: tickets[0]?.high || 0,
      overdueTickets: tickets[0]?.overdue || 0,
      oldestTicketAt: tickets[0]?.oldest || null,
      stuckWork: (work[0]?.total || 0) + (smsJobHealth[0]?.total || 0),
      billingAnomalies,
      oldestWorkAt:
        [work[0]?.oldest, smsJobHealth[0]?.oldest]
          .filter(Boolean)
          .sort((a, b) => a - b)[0] || null,
    },
    observedUsableTrialDays:
      ready.firstReadyObservedAt && date(billing.trialEndsAt)
        ? Math.max(
            0,
            Math.floor(
              date(billing.trialEndsAt) -
                new Date(
                  Math.max(
                    +date(ready.firstReadyObservedAt),
                    +date(billing.trialStartedAt) || 0,
                  ),
                ),
            ) / DAY,
          )
        : null,
    refreshedAt: now,
  };
  row.actions = actionsFor(row, now);
  await AdminBusinessReport.updateOne(
    { business: business._id },
    {
      $set: {
        excluded:
          profile?.excluded === true ||
          business.isTest === true ||
          business.metadata?.isTest === true ||
          business.metadata?.synthetic === true,
        name: business.businessName,
        search:
          `${business.businessName} ${owner?.email || ""} ${owner?.userName || ""}`.toLowerCase(),
        refreshedAt: now,
        nextRefreshAt: new Date(+now + 5 * 60000),
        failureCode: "",
        firstReadyObservedAt: ready.firstReadyObservedAt,
        blockerCode: ready.blockerCode,
        blockerObservedAt: ready.blockerObservedAt,
        payload: row,
      },
      $setOnInsert: { firstObservedAt: now },
    },
    { upsert: true },
  );
  await AdminRevenueSnapshot.updateOne(
    { business: business._id, day: now.toISOString().slice(0, 10) },
    {
      $set: {
        mrrCents: billing.mrrCents,
        paid: billing.paid,
        status: billing.status,
        currency: "usd",
      },
    },
    { upsert: true },
  );
  return row;
};

export const listCustomers = async ({
  page = 1,
  limit = 25,
  search = "",
  attention = false,
  includeExcluded = false,
} = {}) => {
  const match = includeExcluded ? {} : { excluded: false };
  if (search)
    match.search = {
      $regex: search.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    };
  if (attention) match["payload.actions.0"] = { $exists: true };
  const [records, total] = await Promise.all([
    AdminBusinessReport.find(match)
      .sort({ name: 1, business: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("payload refreshedAt failureCode")
      .maxTimeMS(TIMEOUT)
      .lean(),
    AdminBusinessReport.countDocuments(match).maxTimeMS(TIMEOUT),
  ]);
  return {
    customers: records.map((r) => ({
      ...r.payload,
      reportFailed: Boolean(r.failureCode),
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
};
export const founderOverview = async (days = 30) =>
  getOrLoadScaleCache({
    key: `admin:founder:v1:${days}`,
    ttlMs: 30000,
    staleMs: 60000,
    loader: async () => {
      const now = new Date();
      const result = {
        generatedAt: now,
        days,
        timezone: "UTC",
        totalBusinesses: 0,
        reportingBusinesses: 0,
        staleBusinesses: 0,
        excludedBusinesses: 0,
        unknownMrrBusinesses: 0,
        unverifiedSubscriptions: 0,
        trialJourney: {
          started: 0,
          ready: 0,
          interaction: 0,
          booking: 0,
          paid: 0,
        },
        mrrCents: 0,
        payingBusinesses: 0,
        activeTrials: 0,
        activatedTrials: 0,
        businessesWithBookings: 0,
        eligibleBusinesses: 0,
        scheduledCancellationMrrCents: 0,
        delinquentMrrCents: 0,
        renewals7d: 0,
        accountsNeedingAttention: 0,
        cashCollectedCents: 0,
        overdueCents: 0,
        billingCoveredBusinesses: 0,
        knownCostCents: 0,
        marginCents: 0,
        marginRevenueCents: 0,
        costCoveredBusinesses: 0,
        actions: [],
        health: {},
        healthBusinesses: {},
        highestCostAccounts: [],
        outcomes: {},
        previousOutcomes: {},
        sources: Object.create(null),
        plans: Object.create(null),
        cancellationReasons: Object.create(null),
        cohorts: Object.create(null),
        trialsExpiring3d: 0,
        expiredWithoutPayment30d: 0,
        mrrChangeCents: null,
        historyCoveredBusinesses: 0,
        newPayingBusinesses: 0,
        canceledBusinesses: 0,
      };
      const previousDay = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0),
      )
        .toISOString()
        .slice(0, 10);
      const start = new Date(+now - days * DAY);
      const oldRows = await AdminRevenueSnapshot.find({ day: previousDay })
        .select("business mrrCents status")
        .maxTimeMS(TIMEOUT)
        .lean();
      const oldByBusiness = new Map(
        oldRows.map((row) => [String(row.business), row]),
      );
      const cursor = AdminBusinessReport.find({})
        .select("excluded payload refreshedAt failureCode")
        .maxTimeMS(TIMEOUT)
        .lean()
        .cursor({ batchSize: 100 });
      for await (const report of cursor) {
        if (report.excluded) {
          result.excludedBusinesses++;
          continue;
        }
        result.totalBusinesses++;
        const r = report.payload;
        if (!r) {
          result.staleBusinesses++;
          continue;
        }
        result.reportingBusinesses++;
        if (
          report.failureCode ||
          !report.refreshedAt ||
          now - new Date(report.refreshedAt) > 15 * 60000
        )
          result.staleBusinesses++;
        const b = r.billing;
        result.unknownMrrBusinesses += Number(b.paid && !b.priceKnown);
        result.unverifiedSubscriptions += Number(
          b.status === "active" &&
            !b.paymentKnown &&
            !b.complimentaryOrUnbacked,
        );
        if (inRange(b.trialStartedAt, start, now)) {
          const j = result.trialJourney;
          j.started++;
          j.ready += Number(r.readiness.ready);
          j.interaction += Number(
            r.windows[days].calls > 0 || r.windows[days].inboundMessages > 0,
          );
          j.booking += Number(r.windows[days].bookings > 0);
          j.paid += Number(Boolean(b.firstPaidAt));
        }
        result.mrrCents += b.mrrCents || 0;
        result.payingBusinesses += Number(b.paid);
        result.activeTrials += Number(b.trial);
        result.activatedTrials += Number(b.trial && r.readiness.ready);
        result.scheduledCancellationMrrCents +=
          b.scheduledCancellationMrrCents || 0;
        result.delinquentMrrCents += b.delinquentMrrCents || 0;
        result.renewals7d += Number(b.renewsWithin7Days);
        const w = r.windows[days];
        const p = r.windows[`previous${days}`];
        result.eligibleBusinesses += Number(w.calls > 0 || w.messages > 0);
        result.businessesWithBookings += Number(
          (w.calls > 0 || w.messages > 0) && w.bookings > 0,
        );
        for (const [key, value] of Object.entries(w))
          if (typeof value === "number")
            result.outcomes[key] = (result.outcomes[key] || 0) + value;
        for (const [key, value] of Object.entries(p))
          if (typeof value === "number")
            result.previousOutcomes[key] =
              (result.previousOutcomes[key] || 0) + value;
        for (const [key, value] of Object.entries(r.health))
          if (typeof value === "number") {
            result.health[key] = (result.health[key] || 0) + value;
            result.healthBusinesses[key] =
              (result.healthBusinesses[key] || 0) + Number(value > 0);
          }
        if (r.actions.length) {
          result.accountsNeedingAttention++;
          for (const a of r.actions)
            result.actions.push({
              ...a,
              businessId: r.business._id,
              businessName: r.business.businessName,
            });
          result.actions.sort(
            (a, b) =>
              a.priority - b.priority || (b.ageDays || 0) - (a.ageDays || 0),
          );
          result.actions = result.actions.slice(0, 50);
        }
        if (b.coverage === "reconciled") {
          result.billingCoveredBusinesses++;
          result.cashCollectedCents += b.cashCollectedCents;
          result.overdueCents += b.overdueCents;
        }
        result.knownCostCents += r.cost.knownCostCents;
        if (r.cost.knownCostCents > 0) {
          result.highestCostAccounts.push({
            businessId: r.business._id,
            businessName: r.business.businessName,
            costCents: r.cost.knownCostCents,
            complete: r.cost.complete,
            supportMinutes: r.cost.supportMinutes,
          });
          result.highestCostAccounts.sort((a, b) => b.costCents - a.costCents);
          result.highestCostAccounts = result.highestCostAccounts.slice(0, 10);
        }
        if (r.cost.marginCents !== null) {
          result.costCoveredBusinesses++;
          result.marginCents += r.cost.marginCents;
          result.marginRevenueCents += r.cost.revenueCents;
        }
        result.plans[b.plan] = (result.plans[b.plan] || 0) + (b.mrrCents || 0);
        const source = result.sources[r.source] || {
          businesses: 0,
          paid: 0,
          mrrCents: 0,
        };
        source.businesses++;
        source.paid += Number(b.paid);
        source.mrrCents += b.mrrCents || 0;
        result.sources[r.source] = source;
        if (b.cancelAtPeriodEnd || b.status === "canceled")
          result.cancellationReasons[b.cancellationReason] =
            (result.cancellationReasons[b.cancellationReason] || 0) + 1;
        if (inRange(b.firstPaidAt, start, now)) result.newPayingBusinesses++;
        if (b.trial && date(b.trialEndsAt) <= new Date(+now + 3 * DAY))
          result.trialsExpiring3d++;
        if (
          inRange(b.trialEndsAt, new Date(+now - 30 * DAY), now) &&
          !b.firstPaidAt &&
          b.coverage === "reconciled"
        )
          result.expiredWithoutPayment30d++;
        if (date(b.trialStartedAt)) {
          const key = new Date(b.trialStartedAt).toISOString().slice(0, 7);
          const c = result.cohorts[key] || {
            started: 0,
            matured: 0,
            covered: 0,
            converted: 0,
          };
          c.started++;
          const deadline = new Date(+date(b.trialStartedAt) + 30 * DAY);
          if (deadline <= now) {
            c.matured++;
            if (b.coverage === "reconciled") {
              c.covered++;
              if (inRange(b.firstPaidAt, date(b.trialStartedAt), deadline))
                c.converted++;
            }
          }
          result.cohorts[key] = c;
        }
        const old = oldByBusiness.get(String(r.business._id));
        if (old && old.mrrCents !== null && b.priceKnown) {
          result.historyCoveredBusinesses++;
          result.mrrChangeCents =
            (result.mrrChangeCents || 0) +
            (b.mrrCents || 0) -
            (old.mrrCents || 0);
          if (old.status !== "canceled" && b.status === "canceled")
            result.canceledBusinesses++;
        }
      }
      const [businessTotal, demo] = await Promise.all([
        Business.countDocuments({}).maxTimeMS(TIMEOUT),
        aggregate(DemoRequest, [
          {
            $match: {
              createdAt: { $gte: start, $lt: now },
              status: { $ne: "spam" },
            },
          },
          ...realStages(false),
          {
            $group: {
              _id: null,
              requested: { $sum: 1 },
              held: sumIf({ $ne: [{ $ifNull: ["$completedAt", null] }, null] }),
              converted: sumIf({
                $ne: [{ $ifNull: ["$convertedBusiness", null] }, null],
              }),
            },
          },
        ]),
      ]);
      result.companyExpenses = await companyExpenseSummary(now);
      result.pendingBusinesses = Math.max(
        0,
        businessTotal - result.totalBusinesses - result.excludedBusinesses,
      );
      result.demos = demo[0] || { requested: 0, held: 0, converted: 0 };
      result.bookingBusinessRate = rate(
        result.businessesWithBookings,
        result.eligibleBusinesses,
      );
      result.marginRate =
        result.costCoveredBusinesses === result.reportingBusinesses &&
        result.reportingBusinesses > 0 &&
        result.marginRevenueCents > 0
          ? result.marginCents / result.marginRevenueCents
          : null;
      if (
        result.billingCoveredBusinesses !== result.reportingBusinesses ||
        !result.reportingBusinesses
      ) {
        result.cashCollectedCents = null;
        result.overdueCents = null;
      }
      if (
        result.historyCoveredBusinesses !== result.reportingBusinesses ||
        !result.reportingBusinesses
      ) {
        result.mrrChangeCents = null;
        result.canceledBusinesses = null;
      }
      result.cohorts = Object.entries(result.cohorts)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 12)
        .map(([month, c]) => ({
          month,
          ...c,
          conversion: rate(c.converted, c.covered),
        }));
      result.sources = Object.entries(result.sources)
        .map(([source, data]) => ({ source, ...data }))
        .sort((a, b) => b.businesses - a.businesses)
        .slice(0, 30);
      return result;
    },
  });
export const getSafeCustomerDetails = async (businessId) => {
  const business = await Business.findById(businessId)
    .select(BUSINESS_FIELDS)
    .maxTimeMS(TIMEOUT)
    .lean();
  if (!business) return null;
  const [owner, subscription, report, reportingProfile] = await Promise.all([
    User.findById(business.owner).select(OWNER_FIELDS).lean(),
    Subscription.findOne({ business: business._id })
      .select(
        "plan status aiEnabled priceMonthly currentPeriodEnd cancelAtPeriodEnd",
      )
      .lean(),
    AdminBusinessReport.findOne({ business: business._id })
      .select("payload failureCode")
      .lean(),
    AdminReportingProfile.findOne({ business: business._id })
      .select(
        "excluded exclusionReason acquisitionSource cancellationReason nextAction followUpAt",
      )
      .lean(),
  ]);
  const row = report?.payload;
  const w = row?.windows?.[30];
  return {
    business: {
      _id: business._id,
      businessName: business.businessName,
      businessType: business.businessType,
      isActive: business.isActive,
      estimatedJobValue: business.estimatedJobValue,
      createdAt: business.createdAt,
    },
    owner,
    subscription,
    metrics: w
      ? {
          leads: w.leads,
          calls: w.calls,
          missedCalls: w.missedCalls,
          recoveredCalls: w.recoveredCalls,
          messages: w.messages,
          bookedLeads: w.bookedLeads,
        }
      : null,
    reporting: row || null,
    reportingProfile,
    reportFailed: Boolean(report?.failureCode),
  };
};
export const reportingModels = {
  Business,
  User,
  Lead,
  CallLog,
  Message,
  Conversation,
  Appointment,
  ConversionEvent,
};
