import { Alert, INTERVENTION_TYPES, escapeRegex, getOwnedBusiness, listBusinessRequests, mongoose, populate, readRequestWorkflow, updateRequestWorkflow } from './context.js';

export default class InterventionReadsController {
static async list(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });

      if (req.query.view === 'requests') {
        const result = await listBusinessRequests({ businessId: business._id, query: req.query });
        return res.status(200).json({ success: true, ...result });
      }

      const filter = {
        business: business._id,
        $or: [
          { 'metadata.approvalRequest': true, actionRequired: true },
          { type: 'system', actionRequired: true, 'metadata.serviceEligibilityReason': { $exists: true } },
          { type: 'system', actionRequired: true, 'metadata.additionalRequest': { $exists: true } },
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

      // Scope before pagination so a linked customer is never hidden by other alerts.
      for (const [parameter, field] of [["leadId", "lead"], ["conversationId", "conversation"]]) {
        if (!req.query[parameter]) continue;
        if (!mongoose.isObjectIdOrHexString(req.query[parameter])) {
          return res.status(400).json({ success: false, message: `Invalid ${parameter}.` });
        }
        filter[field] = new mongoose.Types.ObjectId(req.query[parameter]);
      }
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

static async workflow(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.body?.businessId || req.query.businessId });
      const data = req.method === 'GET'
        ? await readRequestWorkflow({ businessId: business._id, alertId: req.params.id })
        : await updateRequestWorkflow({ business, userId: req.user.userId, alertId: req.params.id, input: req.body || {} });
      return res.status(200).json({ success: true, data });
    } catch (error) { return next(error); }
  }
}
