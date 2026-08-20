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
  "appointment_change_review",
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

  const firstDue = first.dueAt
    ? new Date(first.dueAt).getTime()
    : Number.MAX_SAFE_INTEGER;
  const secondDue = second.dueAt
    ? new Date(second.dueAt).getTime()
    : Number.MAX_SAFE_INTEGER;

  if (firstDue !== secondDue) return firstDue - secondDue;

  return (
    new Date(second.createdAt || 0).getTime() -
    new Date(first.createdAt || 0).getTime()
  );
};

const sendNotFound = (res) =>
  res.status(404).json({
    success: false,
    message: "Intervention not found.",
  });

const sendStateConflict = (res) =>
  res.status(409).json({
    success: false,
    message: "The intervention changed before this action completed. Refresh and try again.",
  });

const getScopedIntervention = ({ interventionId, businessId }) =>
  Alert.findOne({
    _id: interventionId,
    business: businessId,
  });

const getDefaultAssignee = ({ requestedAssignee, business, user }) =>
  requestedAssignee || business?.owner || user?.userId || null;

const normalizeId = (value) => {
  if (value == null) return null;

  const candidate = value?._id ?? value;
  const normalized = String(candidate).trim();
  return normalized || null;
};

const resolveAssignableUserId = ({ business, requestedAssignee }) => {
  const requestedAssigneeId = normalizeId(requestedAssignee);

  // An explicit null means the intervention should be unassigned.
  if (!requestedAssigneeId) return null;

  const ownerId = normalizeId(business?.owner);
  if (!ownerId || requestedAssigneeId !== ownerId) {
    const error = new Error(
      "Only the business owner can be assigned to an intervention.",
    );
    error.statusCode = 403;
    throw error;
  }

  return ownerId;
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

      if (req.query.resolved === "true") {
        filter.resolvedAt = { $ne: null };
      } else if (req.query.resolved !== "all") {
        filter.resolvedAt = null;
      }

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
      const requestedSkip = Math.max(Number(req.query.skip) || 0, 0);

      const [orderedRows, total] = await Promise.all([
        Alert.aggregate([
          { $match: filter },
          {
            $addFields: {
              __priorityRank: {
                $switch: {
                  branches: [
                    { case: { $eq: ["$priority", "critical"] }, then: 4 },
                    { case: { $eq: ["$priority", "high"] }, then: 3 },
                    { case: { $eq: ["$priority", "medium"] }, then: 2 },
                    { case: { $eq: ["$priority", "low"] }, then: 1 },
                  ],
                  default: 0,
                },
              },
              __dueSort: {
                $ifNull: ["$dueAt", new Date("9999-12-31T23:59:59.999Z")],
              },
            },
          },
          {
            $sort: {
              __priorityRank: -1,
              __dueSort: 1,
              createdAt: -1,
              _id: 1,
            },
          },
          { $skip: requestedSkip },
          { $limit: requestedLimit },
          { $project: { _id: 1 } },
        ]),
        Alert.countDocuments(filter),
      ]);

      const orderedIds = orderedRows.map((row) => row._id);
      const populated = orderedIds.length
        ? await populate(
            Alert.find({
              _id: { $in: orderedIds },
              business: business._id,
            }),
          ).lean()
        : [];
      const byId = new Map(
        populated.map((item) => [String(item._id), item]),
      );
      const alerts = orderedIds
        .map((id) => byId.get(String(id)))
        .filter(Boolean);

      return res.status(200).json({
        success: true,
        data: alerts,
        pagination: {
          total,
          limit: requestedLimit,
          skip: requestedSkip,
          hasMore: requestedSkip + alerts.length < total,
        },
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

      const existing = await getScopedIntervention({
        interventionId: req.params.id,
        businessId: business._id,
      });

      if (!existing) return sendNotFound(res);

      if (existing.resolvedAt) {
        return res.status(409).json({
          success: false,
          message: "A resolved intervention cannot be acknowledged.",
        });
      }

      if (existing.acknowledgedAt) {
        const current = await populate(
          Alert.findOne({
            _id: req.params.id,
            business: business._id,
          }),
        );

        return res.status(200).json({ success: true, data: current });
      }

      const now = new Date();
      const assignedTo = getDefaultAssignee({
        requestedAssignee: req.body.assignedTo,
        business,
        user: req.user,
      });
      const set = {
        status: "acknowledged",
        acknowledgedAt: now,
        acknowledgedBy: req.user.userId,
      };

      if (assignedTo) {
        set.assignedTo = assignedTo;
        set.assignedAt = now;
        set.assignedBy = req.user.userId;
      }

      const alert = await populate(
        Alert.findOneAndUpdate(
          {
            _id: req.params.id,
            business: business._id,
            resolvedAt: null,
            acknowledgedAt: null,
          },
          { $set: set },
          { returnDocument: "after", runValidators: true },
        ),
      );

      if (!alert) return sendStateConflict(res);

      SocketService.emitAlertUpdated(business._id, alert);

      return res.status(200).json({
        success: true,
        data: alert,
      });
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

      const existing = await getScopedIntervention({
        interventionId: req.params.id,
        businessId: business._id,
      });

      if (!existing) return sendNotFound(res);

      if (existing.resolvedAt) {
        const current = await populate(
          Alert.findOne({
            _id: req.params.id,
            business: business._id,
          }),
        );

        return res.status(200).json({ success: true, data: current });
      }

      const now = new Date();
      const assignedTo = getDefaultAssignee({
        requestedAssignee: existing.assignedTo,
        business,
        user: req.user,
      });
      const resolution =
        String(req.body.resolution || "").trim() || "Resolved by staff.";
      const set = {
        status: "resolved",
        resolvedAt: now,
        resolvedBy: req.user.userId,
        resolution,
        actionRequired: false,
        readAt: existing.readAt || now,
        acknowledgedAt: existing.acknowledgedAt || now,
        acknowledgedBy: existing.acknowledgedBy || req.user.userId,
      };

      if (assignedTo) set.assignedTo = assignedTo;

      if (!existing.assignedTo && assignedTo) {
        set.assignedAt = now;
        set.assignedBy = req.user.userId;
      }

      const alert = await populate(
        Alert.findOneAndUpdate(
          {
            _id: req.params.id,
            business: business._id,
            resolvedAt: null,
          },
          { $set: set },
          { returnDocument: "after", runValidators: true },
        ),
      );

      if (!alert) return sendStateConflict(res);

      SocketService.emitAlertUpdated(business._id, alert);
      SocketService.emitDashboardRefresh(
        business._id,
        "intervention:resolved",
      );

      return res.status(200).json({
        success: true,
        data: alert,
      });
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

      const existing = await getScopedIntervention({
        interventionId: req.params.id,
        businessId: business._id,
      });

      if (!existing) return sendNotFound(res);

      if (existing.resolvedAt) {
        return res.status(409).json({
          success: false,
          message: "A resolved intervention cannot be reassigned.",
        });
      }

      const hasExplicitAssignee = Object.prototype.hasOwnProperty.call(
        req.body,
        "assignedTo",
      );
      const requestedAssignee = hasExplicitAssignee
        ? req.body.assignedTo
        : business.owner;
      const assignedTo = resolveAssignableUserId({
        business,
        requestedAssignee,
      });

      const assignmentUpdate = assignedTo
        ? {
            assignedTo,
            assignedAt: new Date(),
            assignedBy: req.user.userId,
          }
        : {
            assignedTo: null,
            assignedAt: null,
            assignedBy: null,
          };

      const alert = await populate(
        Alert.findOneAndUpdate(
          {
            _id: req.params.id,
            business: business._id,
            resolvedAt: null,
          },
          { $set: assignmentUpdate },
          { returnDocument: "after", runValidators: true },
        ),
      );

      if (!alert) return sendStateConflict(res);

      SocketService.emitAlertUpdated(business._id, alert);

      return res.status(200).json({
        success: true,
        data: alert,
      });
    } catch (error) {
      return next(error);
    }
  }
}

export {
  INTERVENTION_TYPES,
  SEVERITY_RANK,
  compareInterventions,
  resolveAssignableUserId,
};
export default InterventionController;
