import { assignOpenReview } from '../../services/stateTransitions/reviews.js';
import Alert from "../../models/alert.js";
import SocketService from "../../services/socket.service.js";
import getOwnedBusiness from "../../services/businessScope.service.js";
import { getScopedIntervention, populate, resolveAssignableUserId, sendNotFound, sendStateConflict } from "./helpers.js";
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
        assignOpenReview({ Alert, assignmentUpdate, business, req }),
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
