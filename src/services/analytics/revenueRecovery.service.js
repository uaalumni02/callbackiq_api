import Appointment from "../../models/appointment.js";
import CallLog from "../../models/callLog.js";
import ConversionEvent from "../../models/conversionEvent.js";
import Lead from "../../models/lead.js";
import MarketingSource from "../../models/marketingSource.js"; // CALLBACKIQ_MARKETING_ATTRIBUTION_V1

const getRange = ({ startDate, endDate }) => {
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate
    ? new Date(startDate)
    : new Date(end.getTime() - 30 * 86_400_000);
  return { start, end };
};

const safeRate = (numerator, denominator) =>
  denominator > 0 ? numerator / denominator : 0;

class RevenueRecoveryService {
  static async summary({ businessId, startDate, endDate }) {
    const { start, end } = getRange({ startDate, endDate });
    const dateFilter = { $gte: start, $lte: end };
    const [
      missedCalls,
      customersReached,
      qualifiedLeads,
      humanInterventions,
      lostOpportunities,
      booked,
      recovered,
      responseTiming,
    ] = await Promise.all([
      CallLog.countDocuments({
        business: businessId,
        status: { $in: ["missed", "voicemail", "failed", "busy", "no_answer"] },
        createdAt: dateFilter,
      }),
      Lead.countDocuments({
        business: businessId,
        firstRespondedAt: dateFilter,
      }),
      Lead.countDocuments({ business: businessId, qualifiedAt: dateFilter }),
      ConversionEvent.countDocuments({
        business: businessId,
        type: "human_takeover",
        occurredAt: dateFilter,
      }),
      Lead.countDocuments({
        business: businessId,
        status: "lost",
        createdAt: dateFilter,
      }),
      Appointment.aggregate([
        {
          $match: {
            business: businessId,
            status: { $in: ["confirmed", "completed", "no_show"] },
            confirmedAt: dateFilter,
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            estimated: {
              $sum: {
                $cond: [{ $eq: ["$status", "confirmed"] }, "$estimatedValue", 0],
              },
            },
            actual: {
              $sum: {
                $cond: [{ $eq: ["$status", "completed"] }, "$actualRevenue", 0],
              },
            },
            attributable: {
              $sum: {
                $switch: {
                  branches: [
                    {
                      case: { $eq: ["$status", "completed"] },
                      then: "$actualRevenue",
                    },
                    {
                      case: { $eq: ["$status", "confirmed"] },
                      then: "$estimatedValue",
                    },
                  ],
                  default: 0,
                },
              },
            },
          },
        },
      ]),
      Lead.aggregate([
        { $match: { business: businessId, recovered: true, bookedAt: dateFilter } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            // Open pipeline only: once actual revenue exists, do not also count
            // the estimate for the same recovered job.
            estimated: {
              $sum: {
                $cond: [
                  { $ne: ["$completedAt", null] },
                  0,
                  "$estimatedValue",
                ],
              },
            },
            actual: { $sum: "$actualRevenue" },
            attributable: {
              $sum: {
                $cond: [
                  { $ne: ["$completedAt", null] },
                  "$actualRevenue",
                  "$estimatedValue",
                ],
              },
            },
          },
        },
      ]),
      ConversionEvent.aggregate([
        {
          $match: {
            business: businessId,
            type: "first_response",
            occurredAt: dateFilter,
            "metadata.responseSeconds": { $type: "number" },
          },
        },
        { $group: { _id: null, average: { $avg: "$metadata.responseSeconds" } } },
      ]),
    ]);

    const appointmentSummary = booked[0] || {
      count: 0,
      estimated: 0,
      actual: 0,
      attributable: 0,
    };
    const recoveredSummary = recovered[0] || {
      count: 0,
      estimated: 0,
      actual: 0,
      attributable: 0,
    };

    return {
      missedCalls,
      customersReached,
      qualifiedLeads,
      appointmentsBooked: appointmentSummary.count,
      recoveredLeads: recoveredSummary.count,
      humanInterventions,
      lostOpportunities,
      responseRate: safeRate(customersReached, missedCalls),
      qualificationRate: safeRate(qualifiedLeads, customersReached),
      bookingRate: safeRate(appointmentSummary.count, missedCalls),
      humanInterventionRate: safeRate(
        humanInterventions,
        customersReached || missedCalls,
      ),
      estimatedRecoveredRevenue: recoveredSummary.estimated || 0,
      actualRecoveredRevenue: recoveredSummary.actual || 0,
      totalRecoveredAttributableValue: recoveredSummary.attributable || 0,
      estimatedBookedRevenue: appointmentSummary.estimated || 0,
      actualBookedRevenue: appointmentSummary.actual || 0,
      totalBookedAttributableValue: appointmentSummary.attributable || 0,
      averageFirstResponseSeconds: Math.round(responseTiming[0]?.average || 0),
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }

  static async trends({ businessId, startDate, endDate }) {
    // CALLBACKIQ_ATTRIBUTION_10OF10_FULL_V2:
    // Return the exact daily contract consumed by RevenueRecovery.js. We use
    // authoritative collections instead of assuming every lifecycle stage has
    // a ConversionEvent.
    const { start, end } = getRange({ startDate, endDate });
    const dateFilter = { $gte: start, $lte: end };
    const missedStatuses = ["missed", "voicemail", "failed", "busy", "no_answer"];
    const dayGroup = (dateExpression) => ({
      $dateToString: { format: "%Y-%m-%d", date: dateExpression },
    });

    const [missedRows, qualifiedRows, bookedRows, recoveredRows] =
      await Promise.all([
        CallLog.aggregate([
          {
            $match: {
              business: businessId,
              status: { $in: missedStatuses },
              createdAt: dateFilter,
            },
          },
          {
            $group: {
              _id: dayGroup("$createdAt"),
              missedCalls: { $sum: 1 },
            },
          },
        ]),
        Lead.aggregate([
          {
            $match: {
              business: businessId,
              qualifiedAt: dateFilter,
            },
          },
          {
            $group: {
              _id: dayGroup("$qualifiedAt"),
              qualifiedLeads: { $sum: 1 },
            },
          },
        ]),
        Appointment.aggregate([
          {
            $match: {
              business: businessId,
              status: { $in: ["confirmed", "completed", "no_show"] },
              confirmedAt: dateFilter,
            },
          },
          {
            $group: {
              _id: dayGroup("$confirmedAt"),
              appointmentsBooked: { $sum: 1 },
            },
          },
        ]),
        Lead.aggregate([
          {
            $match: {
              business: businessId,
              recovered: true,
              bookedAt: dateFilter,
            },
          },
          {
            $group: {
              _id: dayGroup("$bookedAt"),
              recoveredLeads: { $sum: 1 },
              estimatedRecoveredRevenue: {
                $sum: {
                  $cond: [
                    { $ne: ["$completedAt", null] },
                    0,
                    "$estimatedValue",
                  ],
                },
              },
              actualRecoveredRevenue: { $sum: "$actualRevenue" },
            },
          },
        ]),
      ]);

    const rows = new Map();
    const ensure = (period) => {
      if (!rows.has(period)) {
        rows.set(period, {
          _id: period,
          period,
          missedCalls: 0,
          qualifiedLeads: 0,
          appointmentsBooked: 0,
          recoveredLeads: 0,
          estimatedRecoveredRevenue: 0,
          actualRecoveredRevenue: 0,
        });
      }
      return rows.get(period);
    };

    for (const sourceRows of [
      missedRows,
      qualifiedRows,
      bookedRows,
      recoveredRows,
    ]) {
      for (const row of sourceRows) {
        if (!row?._id) continue;
        Object.assign(ensure(row._id), row, { _id: row._id, period: row._id });
      }
    }

    return [...rows.values()].sort((left, right) =>
      String(left.period).localeCompare(String(right.period)),
    );
  }

  static async sources({ businessId, startDate, endDate }) {
    const { start, end } = getRange({ startDate, endDate });
    return Lead.aggregate([
      { $match: { business: businessId, createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: "$source",
          leads: { $sum: 1 },
          recovered: { $sum: { $cond: ["$recovered", 1, 0] } },
          estimatedRevenue: { $sum: { $cond: ["$recovered", "$estimatedValue", 0] } },
          actualRevenue: { $sum: { $cond: ["$recovered", "$actualRevenue", 0] } },
        },
      },
      { $sort: { leads: -1 } },
    ]);
  }

  static async marketingSources({ businessId, startDate, endDate }) {
    // CALLBACKIQ_ATTRIBUTION_10OF10_V1: marketing source revenue reconciliation
    const { start, end } = getRange({ startDate, endDate });
    const dateFilter = { $gte: start, $lte: end };
    const missedStatuses = ["missed", "voicemail", "failed", "busy", "no_answer"];

    const [sourceDocuments, callRows, bookingRows, recoveredBookingEvents] =
      await Promise.all([
        // Include archived sources so historical reports never lose their label.
        MarketingSource.find({ business: businessId }).lean(),
        CallLog.aggregate([
          { $match: { business: businessId, createdAt: dateFilter } },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: "$marketingSource",
              totalCalls: { $sum: 1 },
              answeredCalls: {
                $sum: { $cond: [{ $eq: ["$status", "answered"] }, 1, 0] },
              },
              missedCalls: {
                $sum: { $cond: [{ $in: ["$status", missedStatuses] }, 1, 0] },
              },
              recoveredCalls: { $sum: { $cond: ["$recovered", 1, 0] } },
              snapshotSourceName: { $first: "$attribution.sourceName" },
              snapshotChannel: { $first: "$attribution.channel" },
              snapshotCampaign: { $first: "$attribution.campaign" },
            },
          },
        ]),
        Appointment.aggregate([
          {
            $match: {
              business: businessId,
              status: { $in: ["confirmed", "completed", "no_show"] },
              confirmedAt: dateFilter,
            },
          },
          { $sort: { confirmedAt: -1 } },
          {
            $group: {
              _id: "$marketingSource",
              bookedJobs: { $sum: 1 },
              actualBookedRevenue: {
                $sum: {
                  $cond: [{ $eq: ["$status", "completed"] }, "$actualRevenue", 0],
                },
              },
              estimatedBookedRevenue: {
                $sum: {
                  $cond: [{ $eq: ["$status", "confirmed"] }, "$estimatedValue", 0],
                },
              },
              totalBookedAttributableValue: {
                $sum: {
                  $switch: {
                    branches: [
                      { case: { $eq: ["$status", "completed"] }, then: "$actualRevenue" },
                      { case: { $eq: ["$status", "confirmed"] }, then: "$estimatedValue" },
                    ],
                    default: 0,
                  },
                },
              },
              snapshotSourceName: { $first: "$attribution.sourceName" },
              snapshotChannel: { $first: "$attribution.channel" },
              snapshotCampaign: { $first: "$attribution.campaign" },
            },
          },
        ]),
        ConversionEvent.find({
          business: businessId,
          type: "appointment_booked",
          occurredAt: dateFilter,
          "metadata.recovered": true,
        })
          .select("appointment marketingSource attribution estimatedValue occurredAt")
          .sort({ occurredAt: 1 })
          .lean(),
      ]);

    const recoveredAppointmentIds = [
      ...new Set(
        recoveredBookingEvents
          .map((event) => event.appointment)
          .filter(Boolean)
          .map((id) => String(id)),
      ),
    ];

    const [completionEvents, recoveredAppointments] = recoveredAppointmentIds.length
      ? await Promise.all([
          // Deliberately no occurredAt range: a July booking completed in August
          // must still reconcile July's booked cohort to its final revenue.
          ConversionEvent.find({
            business: businessId,
            type: "job_completed",
            appointment: { $in: recoveredAppointmentIds },
          })
            .select("appointment actualRevenue occurredAt attribution marketingSource")
            .sort({ occurredAt: 1 })
            .lean(),
          Appointment.find({
            business: businessId,
            _id: { $in: recoveredAppointmentIds },
          })
            .select("status actualRevenue")
            .lean(),
        ])
      : [[], []];

    const completionByAppointment = new Map();
    for (const event of completionEvents) {
      if (event.appointment) completionByAppointment.set(String(event.appointment), event);
    }
    const appointmentById = new Map(
      recoveredAppointments.map((appointment) => [String(appointment._id), appointment]),
    );

    const recoveredRows = new Map();
    for (const event of recoveredBookingEvents) {
      const sourceKey = event.marketingSource ? String(event.marketingSource) : "unattributed";
      if (!recoveredRows.has(sourceKey)) {
        recoveredRows.set(sourceKey, {
          _id: event.marketingSource || null,
          recoveredBookedJobs: 0,
          actualRecoveredRevenue: 0,
          estimatedRecoveredRevenue: 0,
          totalRecoveredAttributableValue: 0,
          snapshotSourceName: event.attribution?.sourceName || "",
          snapshotChannel: event.attribution?.channel || "",
          snapshotCampaign: event.attribution?.campaign || "",
        });
      }
      const row = recoveredRows.get(sourceKey);
      row.recoveredBookedJobs += 1;
      if (!row.snapshotSourceName && event.attribution?.sourceName) {
        row.snapshotSourceName = event.attribution.sourceName;
        row.snapshotChannel = event.attribution?.channel || "";
        row.snapshotCampaign = event.attribution?.campaign || "";
      }

      const appointmentId = event.appointment ? String(event.appointment) : "";
      const completionEvent = appointmentId ? completionByAppointment.get(appointmentId) : null;
      const appointment = appointmentId ? appointmentById.get(appointmentId) : null;
      const completed = Boolean(completionEvent) || appointment?.status === "completed";
      if (completed) {
        const actual = Number(
          completionEvent?.actualRevenue ?? appointment?.actualRevenue ?? 0,
        );
        row.actualRecoveredRevenue += Number.isFinite(actual) ? actual : 0;
        row.totalRecoveredAttributableValue += Number.isFinite(actual) ? actual : 0;
      } else {
        const estimate = Number(event.estimatedValue || 0);
        row.estimatedRecoveredRevenue += Number.isFinite(estimate) ? estimate : 0;
        row.totalRecoveredAttributableValue += Number.isFinite(estimate) ? estimate : 0;
      }
    }

    const rows = new Map();
    const keyFor = (id) => (id ? String(id) : "unattributed");
    const ensure = (id) => {
      const key = keyFor(id);
      if (!rows.has(key)) {
        rows.set(key, {
          sourceId: id ? String(id) : null,
          name: id ? "Unknown source" : "Unattributed",
          channel: id ? "other" : "unattributed",
          campaign: "",
          status: id ? "unknown" : "unattributed",
          totalCalls: 0,
          answeredCalls: 0,
          missedCalls: 0,
          recoveredCalls: 0,
          bookedJobs: 0,
          recoveredBookedJobs: 0,
          // Compatibility names now have precise semantics:
          // actual = realized completed revenue; estimated = open confirmed pipeline.
          estimatedBookedRevenue: 0,
          actualBookedRevenue: 0,
          totalBookedAttributableValue: 0,
          estimatedRecoveredRevenue: 0,
          actualRecoveredRevenue: 0,
          totalRecoveredAttributableValue: 0,
        });
      }
      return rows.get(key);
    };

    const applySnapshot = (target, row) => {
      if (!target.sourceId) return;
      if (target.name === "Unknown source" && row?.snapshotSourceName) {
        target.name = row.snapshotSourceName;
      }
      if ((!target.channel || target.channel === "other") && row?.snapshotChannel) {
        target.channel = row.snapshotChannel;
      }
      if (!target.campaign && row?.snapshotCampaign) {
        target.campaign = row.snapshotCampaign;
      }
    };

    for (const source of sourceDocuments) {
      Object.assign(ensure(source._id), {
        name: source.name,
        channel: source.channel,
        campaign: source.campaign || "",
        status: source.status,
      });
    }
    for (const row of callRows) {
      const target = ensure(row._id);
      Object.assign(target, {
        totalCalls: row.totalCalls || 0,
        answeredCalls: row.answeredCalls || 0,
        missedCalls: row.missedCalls || 0,
        recoveredCalls: row.recoveredCalls || 0,
      });
      applySnapshot(target, row);
    }
    for (const row of bookingRows) {
      const target = ensure(row._id);
      Object.assign(target, {
        bookedJobs: row.bookedJobs || 0,
        actualBookedRevenue: row.actualBookedRevenue || 0,
        estimatedBookedRevenue: row.estimatedBookedRevenue || 0,
        totalBookedAttributableValue: row.totalBookedAttributableValue || 0,
      });
      applySnapshot(target, row);
    }
    for (const row of recoveredRows.values()) {
      const target = ensure(row._id);
      Object.assign(target, {
        recoveredBookedJobs: row.recoveredBookedJobs || 0,
        actualRecoveredRevenue: row.actualRecoveredRevenue || 0,
        estimatedRecoveredRevenue: row.estimatedRecoveredRevenue || 0,
        totalRecoveredAttributableValue: row.totalRecoveredAttributableValue || 0,
      });
      applySnapshot(target, row);
    }

    return [...rows.values()]
      .filter(
        (row) =>
          row.totalCalls ||
          row.bookedJobs ||
          row.recoveredBookedJobs ||
          (row.sourceId && row.status !== "archived"),
      )
      .sort(
        (left, right) =>
          right.totalCalls - left.totalCalls ||
          right.totalBookedAttributableValue - left.totalBookedAttributableValue,
      );
  }

  static async lostOpportunities({ businessId, startDate, endDate, limit = 100 }) {
    const { start, end } = getRange({ startDate, endDate });
    return Lead.find({
      business: businessId,
      status: "lost",
      createdAt: { $gte: start, $lte: end },
    })
      .sort({ estimatedValue: -1, createdAt: -1 })
      .limit(Math.min(Number(limit) || 100, 250))
      .lean();
  }

  static async funnel(options) {
    const summary = await this.summary(options);
    return [
      { stage: "Missed inquiries", count: summary.missedCalls },
      { stage: "Customers reached", count: summary.customersReached },
      { stage: "Qualified leads", count: summary.qualifiedLeads },
      { stage: "Appointments booked", count: summary.appointmentsBooked },
      { stage: "Recovered leads", count: summary.recoveredLeads },
    ];
  }
}

export default RevenueRecoveryService;
