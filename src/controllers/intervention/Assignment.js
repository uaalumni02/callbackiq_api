import { Alert, SocketService, getOwnedBusiness, getScopedIntervention, populate, resolveAssignableUserId, sendNotFound, sendStateConflict } from './context.js';

export default class InterventionAssignmentController {
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
