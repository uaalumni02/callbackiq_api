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

const normalizeId = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value?.toHexString === "function") return value.toHexString();
  if (typeof value === "object") {
    const nested = value._id ?? value.id;
    if (nested !== undefined && nested !== value) return normalizeId(nested);
  }
  const normalized = String(value).trim();
  return normalized || null;
};

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

const notFound = (res) =>
  res
    .status(404)
    .json({ success: false, message: "Intervention not found." });

const conflict = (res, message) =>
  res.status(409).json({ success: false, message });

const getActorId = (req) => normalizeId(req.user?.userId || req.user?._id);

/*
 * The current data model has one business owner and no BusinessMember model.
 * Until membership is implemented, assignment is deliberately restricted to
 * the business owner so an arbitrary cross-tenant User ID cannot be attached.
 */
const resolveAssignableUserId = ({ business, requestedAssignee }) => {
  if (requestedAssignee === null || requestedAssignee === undefined || requestedAssignee === "") {
    return null;
  }

  const ownerId = normalizeId(business?.owner);
  const assigneeId = normalizeId(requestedAssignee);

  if (!ownerId || assigneeId !== ownerId) {
    const error = new Error(
      "Only the business owner can be assigned until team membership is configured.",
    );
    error.statusCode = 403;
    throw error;
  }

  return assigneeId;
};

const getScopedAlert = async (id, businessId) =>
  populate(Alert.findOne({ _id: id, business: businessId }));

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
      const existing = await getScopedAlert(req.params.id, business._id);

      if (!existing) return notFound(res);
      if (existing.resolvedAt) {
        return conflict(res, "A resolved intervention cannot be acknowledged.");
      }
      if (existing.acknowledgedAt) {
        return res.status(200).json({ success: true, data: existing });
      }

      const now = new Date();
      const actorId = getActorId(req);
      const requestedAssignee = Object.prototype.hasOwnProperty.call(
        req.body,
        "assignedTo",
      )
        ? req.body.assignedTo
        : existing.assignedTo || business.owner;
      const assigneeId = resolveAssignableUserId({
        business,
        requestedAssignee,
      });

      const set = {
        status: "acknowledged",
        acknowledgedAt: now,
        acknowledgedBy: actorId,
      };
      if (!existing.assignedTo && assigneeId) {
        set.assignedTo = assigneeId;
        set.assignedAt = now;
        set.assignedBy = actorId;
      }

      let alert = await populate(
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

      const changed = Boolean(alert);
      /* A concurrent acknowledgement won the race: return its result. */
      if (!alert) alert = await getScopedAlert(req.params.id, business._id);
      if (!alert) return notFound(res);

      if (changed) SocketService.emitAlertUpdated(business._id, alert);
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
      const existing = await getScopedAlert(req.params.id, business._id);

      if (!existing) return notFound(res);
      /* Resolution is idempotent: never rewrite the original audit timestamp. */
      if (existing.resolvedAt) {
        return res.status(200).json({ success: true, data: existing });
      }

      const now = new Date();
      const actorId = getActorId(req);
      const resolution =
        String(req.body.resolution || "Resolved by staff.").trim() ||
        "Resolved by staff.";
      const set = {
        status: "resolved",
        resolvedAt: now,
        resolvedBy: actorId,
        resolution: resolution.slice(0, 2000),
        actionRequired: false,
        readAt: existing.readAt || now,
        acknowledgedAt: existing.acknowledgedAt || now,
        acknowledgedBy: normalizeId(existing.acknowledgedBy) || actorId,
      };

      if (!existing.assignedTo) {
        const assigneeId = resolveAssignableUserId({
          business,
          requestedAssignee: business.owner,
        });
        set.assignedTo = assigneeId;
        set.assignedAt = now;
        set.assignedBy = actorId;
      }

      let alert = await populate(
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

      const changed = Boolean(alert);
      if (!alert) alert = await getScopedAlert(req.params.id, business._id);
      if (!alert) return notFound(res);

      if (changed) {
        SocketService.emitAlertUpdated(business._id, alert);
        SocketService.emitDashboardRefresh(
          business._id,
          "intervention:resolved",
        );
      }
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
      const existing = await getScopedAlert(req.params.id, business._id);

      if (!existing) return notFound(res);
      if (existing.resolvedAt) {
        return conflict(res, "A resolved intervention cannot be reassigned.");
      }
      if (!Object.prototype.hasOwnProperty.call(req.body, "assignedTo")) {
        return res.status(400).json({
          success: false,
          message: "assignedTo is required and may be null to unassign.",
        });
      }

      const assigneeId = resolveAssignableUserId({
        business,
        requestedAssignee: req.body.assignedTo,
      });
      if (normalizeId(existing.assignedTo) === assigneeId) {
        return res.status(200).json({ success: true, data: existing });
      }

      const actorId = getActorId(req);
      const now = new Date();
      const set = assigneeId
        ? {
            assignedTo: assigneeId,
            assignedAt: now,
            assignedBy: actorId,
          }
        : {
            assignedTo: null,
            assignedAt: null,
            assignedBy: null,
          };

      const alert = await populate(
        Alert.findOneAndUpdate(
          { _id: req.params.id, business: business._id, resolvedAt: null },
          { $set: set },
          { returnDocument: "after", runValidators: true },
        ),
      );

      if (!alert) return notFound(res);

      SocketService.emitAlertUpdated(business._id, alert);
      return res.status(200).json({ success: true, data: alert });
    } catch (error) {
      return next(error);
    }
  }
}

export {
  INTERVENTION_TYPES,
  SEVERITY_RANK,
  compareInterventions,
  normalizeId,
  resolveAssignableUserId,
};
export default InterventionController;
