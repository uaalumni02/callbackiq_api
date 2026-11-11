import { Alert, SocketService, getDefaultAssignee, getOwnedBusiness, getScopedIntervention, pauseOwnedReview, populate, resolveAssignableUserId, sendNotFound, sendStateConflict } from './context.js';

export default class InterventionResolutionController {
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

        await pauseOwnedReview(req, business, current);
        return res.status(200).json({ success: true, data: current });
      }

      const now = new Date();
      const assignedTo = resolveAssignableUserId({
        business,
        requestedAssignee: req.body.assignedTo || business.owner || req.user.userId,
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
      await pauseOwnedReview(req, business, alert);

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
      if (existing.metadata?.approvalRequest && !existing.resolvedAt) {
        return res.status(409).json({ success: false,
          message: "Approve or decline the appointment before closing its review." });
      }

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
}
