import Alert from "../models/alert.js";
import getOwnedBusiness from "../services/businessScope.service.js";
import SocketService from "../services/socket.service.js";

const INTERVENTION_TYPES = [
  "safety_emergency",
  "human_requested",
  "angry_customer",
  "high_value_lead",
  "low_ai_confidence",
  "booking_conflict",
  "integration_failure",
  "message_delivery_failure",
  "unanswered_hot_lead",
  "appointment_canceled",
];

const SEVERITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const populate = (query) =>
  query
    .populate(
      "lead",
      "customerName phone serviceNeeded urgency estimatedValue status summary",
    )
    .populate(
      "conversation",
      "customerName customerPhone lastMessage status humanTakeover",
    )
    .populate("appointment", "startAt endAt timezone status provider")
    .populate("assignedTo", "userName email");

const compareInterventions = (first, second) => {
  const severityDifference =
    (SEVERITY_RANK[second.priority] || 0) -
    (SEVERITY_RANK[first.priority] || 0);

  if (severityDifference !== 0) return severityDifference;

  const firstDue = first.dueAt ? new Date(first.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
  const secondDue = second.dueAt ? new Date(second.dueAt).getTime() : Number.MAX_SAFE_INTEGER;

  if (firstDue !== secondDue) return firstDue - secondDue;

  return new Date(second.createdAt || 0).getTime() -
    new Date(first.createdAt || 0).getTime();
};

class InterventionController {
  static async list(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const filter = {
        business: business._id,
        $or: [
          { type: { $in: INTERVENTION_TYPES } },
          {
            type: "system",
            priority: "critical",
            $or: [
              { "metadata.messageCategory": "emergency" },
              {
                "metadata.riskFlags": {
                  $in: ["safety_hazard", "hazardous_diy_request"],
                },
              },
            ],
          },
          { type: "hot_lead", priority: "critical" },
        ],
      };

      if (req.query.priority) filter.priority = req.query.priority;
      if (req.query.type && INTERVENTION_TYPES.includes(req.query.type)) {
        filter.type = req.query.type;
      }
      if (req.query.resolved === "true") filter.resolvedAt = { $ne: null };
      else if (req.query.resolved !== "all") filter.resolvedAt = null;
      if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;

      if (req.query.search) {
        const search = new RegExp(escapeRegex(req.query.search), "i");
        filter.$and = [
          {
            $or: [
              { title: search },
              { message: search },
              { reason: search },
              { recommendedAction: search },
              { lastCustomerMessage: search },
              { aiSummary: search },
            ],
          },
        ];
      }

      const requestedLimit = Math.min(
        Math.max(Number(req.query.limit) || 100, 1),
        250,
      );
      const alerts = await populate(Alert.find(filter))
        .sort({ dueAt: 1, createdAt: -1 })
        .limit(250)
        .lean();

      alerts.sort(compareInterventions);

      return res.status(200).json({
        success: true,
        data: alerts.slice(0, requestedLimit),
      });
    } catch (error) {
      return next(error);
    }
  }

  static async acknowledge(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body.businessId,
      });
      const alert = await populate(
        Alert.findOneAndUpdate(
          { _id: req.params.id, business: business._id, resolvedAt: null },
          {
            $set: {
              status: "acknowledged",
              acknowledgedAt: new Date(),
              assignedTo: req.body.assignedTo || req.user.userId,
            },
          },
          { new: true },
        ),
      );
      if (!alert) {
        return res
          .status(404)
          .json({ success: false, message: "Intervention not found." });
      }
      SocketService.emitAlertUpdated(business._id, alert);
      return res.status(200).json({ success: true, data: alert });
    } catch (error) {
      return next(error);
    }
  }

  static async resolve(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body.businessId,
      });
      const alert = await populate(
        Alert.findOneAndUpdate(
          { _id: req.params.id, business: business._id },
          {
            $set: {
              status: "resolved",
              resolvedAt: new Date(),
              resolution: req.body.resolution || "Resolved by staff.",
              actionRequired: false,
              readAt: new Date(),
            },
          },
          { new: true },
        ),
      );
      if (!alert) {
        return res
          .status(404)
          .json({ success: false, message: "Intervention not found." });
      }
      SocketService.emitAlertUpdated(business._id, alert);
      return res.status(200).json({ success: true, data: alert });
    } catch (error) {
      return next(error);
    }
  }

  static async assign(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.body.businessId,
      });
      const alert = await populate(
        Alert.findOneAndUpdate(
          { _id: req.params.id, business: business._id },
          { $set: { assignedTo: req.body.assignedTo || null } },
          { new: true },
        ),
      );
      if (!alert) {
        return res
          .status(404)
          .json({ success: false, message: "Intervention not found." });
      }
      SocketService.emitAlertUpdated(business._id, alert);
      return res.status(200).json({ success: true, data: alert });
    } catch (error) {
      return next(error);
    }
  }
}

export { INTERVENTION_TYPES, SEVERITY_RANK, compareInterventions };
export default InterventionController;
