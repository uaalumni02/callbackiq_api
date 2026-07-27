import getOwnedBusiness from "../services/businessScope.service.js";
import AvailabilityService from "../services/scheduling/availability.service.js";

class AvailabilityController {
  static async list(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const { serviceOfferingId, startDate, endDate, postalCode } = req.query;

      if (!serviceOfferingId || !startDate || !endDate) {
        return res.status(400).json({
          success: false,
          message: "serviceOfferingId, startDate, and endDate are required.",
        });
      }

      const result = await AvailabilityService.getAvailability({
        business,
        serviceOfferingId,
        startDate,
        endDate,
        postalCode,
      });

      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      return next(error);
    }
  }
}

export default AvailabilityController;
