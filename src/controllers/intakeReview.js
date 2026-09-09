import getOwnedBusiness from "../services/businessScope.service.js";
import { approveIntake } from "../services/booking/intakeReview.service.js";

export default class IntakeReviewController {
  static async approveIntake(req, res, next) {
    try {
      const business = await getOwnedBusiness({ user: req.user, requestedBusinessId: req.body?.businessId });
      const result = await approveIntake({ business, conversationId: req.params.id, input: req.body || {}, approvedBy: req.user?.userId || null });
      return res.status(200).json({ success: true, data: result.appointment, confirmationNoticeStatus: result.confirmationNoticeStatus });
    } catch (error) { return next(error); }
  }

}
