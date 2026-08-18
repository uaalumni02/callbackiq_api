import getOwnedBusiness from "../services/businessScope.service.js";
import OwnerExperienceService from "../services/ownerExperience.service.js";

class OwnerExperienceController {
  static async dashboard(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const data = await OwnerExperienceService.dashboard({
        business,
        period: req.query.period || "today",
      });
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }

  static async opportunities(req, res, next) {
    try {
      const business = await getOwnedBusiness({
        user: req.user,
        requestedBusinessId: req.query.businessId,
      });
      const data = await OwnerExperienceService.opportunities({
        business,
        view: req.query.view || req.query.state || "active",
        search: req.query.search || "",
        limit: req.query.limit || 50,
        skip: req.query.skip || 0,
      });
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  }
}

export default OwnerExperienceController;
