import Appointment from "../../models/appointment.js";
import CallLog from "../../models/callLog.js";
import ConversionEvent from "../../models/conversionEvent.js";
import Lead from "../../models/lead.js";

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
            estimated: { $sum: "$estimatedValue" },
            actual: { $sum: "$actualRevenue" },
          },
        },
      ]),
      Lead.aggregate([
        { $match: { business: businessId, recovered: true, bookedAt: dateFilter } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            estimated: { $sum: "$estimatedValue" },
            actual: { $sum: "$actualRevenue" },
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

    const appointmentSummary = booked[0] || { count: 0, estimated: 0, actual: 0 };
    const recoveredSummary = recovered[0] || { count: 0, estimated: 0, actual: 0 };

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
      estimatedBookedRevenue: appointmentSummary.estimated || 0,
      actualBookedRevenue: appointmentSummary.actual || 0,
      averageFirstResponseSeconds: Math.round(responseTiming[0]?.average || 0),
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }

  static async trends({ businessId, startDate, endDate }) {
    const { start, end } = getRange({ startDate, endDate });
    return ConversionEvent.aggregate([
      { $match: { business: businessId, occurredAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$occurredAt" } },
            type: "$type",
          },
          count: { $sum: 1 },
          estimatedValue: { $sum: "$estimatedValue" },
          actualRevenue: { $sum: "$actualRevenue" },
        },
      },
      { $sort: { "_id.date": 1 } },
    ]);
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
