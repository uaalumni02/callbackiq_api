import { BusinessOperationsSettings, SchedulingPolicy, ServiceArea, evaluateBookingEligibility, evaluateBookingSchema, getBusinessConfigurationBootstrap, getConfigurationReadiness, getOwnerBusiness, operationsSettingsSchema, refreshUpcomingAppointmentNotifications, respondError, respondNotFound, schedulingPolicySchema, serviceAreaSchema } from './context.js';

export default class BusinessConfigurationPolicyController {
static async getSchedulingPolicy(req, res) {
    try {
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const policy = await SchedulingPolicy.findOneAndUpdate(
        { business: business._id },
        { $setOnInsert: { business: business._id } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
      return res.status(200).json({ success: true, data: policy });
    } catch (error) {
      return respondError(res, error);
    }
  }

static async saveSchedulingPolicy(req, res) {
    try {
      const payload = await schedulingPolicySchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const policy = await SchedulingPolicy.findOneAndUpdate(
        { business: business._id },
        { $set: payload, $setOnInsert: { business: business._id } },
        {
          upsert: true,
          returnDocument: "after",
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      );
      let notificationRefreshWarning;
      try { await refreshUpcomingAppointmentNotifications({ businessId: business._id }); }
      catch { notificationRefreshWarning = 'Settings saved, but existing reminder schedules need review.'; }
      return res.status(200).json({
        success: true,
        notificationRefreshWarning,
        message: "Scheduling policy saved",
        data: policy,
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

static async getServiceArea(req, res) {
    try {
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const serviceArea = await ServiceArea.findOneAndUpdate(
        { business: business._id },
        { $setOnInsert: { business: business._id, type: "zip_codes" } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
      return res.status(200).json({ success: true, data: serviceArea });
    } catch (error) {
      return respondError(res, error);
    }
  }

static async saveServiceArea(req, res) {
    try {
      const payload = await serviceAreaSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const serviceArea = await ServiceArea.findOneAndUpdate(
        { business: business._id },
        { $set: payload, $setOnInsert: { business: business._id } },
        {
          upsert: true,
          returnDocument: "after",
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      );
      return res.status(200).json({
        success: true,
        message: "Service area saved",
        data: serviceArea,
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

static async getOperationsSettings(req, res) {
    try {
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const settings = await BusinessOperationsSettings.findOneAndUpdate(
        { business: business._id },
        { $setOnInsert: { business: business._id } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
      return res.status(200).json({ success: true, data: settings });
    } catch (error) {
      return respondError(res, error);
    }
  }

static async saveOperationsSettings(req, res) {
    try {
      const payload = await operationsSettingsSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const settings = await BusinessOperationsSettings.findOneAndUpdate(
        { business: business._id },
        { $set: payload, $setOnInsert: { business: business._id } },
        {
          upsert: true,
          returnDocument: "after",
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      );
      return res.status(200).json({
        success: true,
        message: "Operations settings saved",
        data: settings,
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

static async readiness(req, res) {
    try {
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const bootstrap = await getBusinessConfigurationBootstrap(business);
      const readiness = getConfigurationReadiness({
        services: bootstrap.services,
        rules: bootstrap.availabilityRules,
        schedulingPolicy: bootstrap.schedulingPolicy,
        serviceArea: bootstrap.serviceArea,
        operationsSettings: bootstrap.operationsSettings,
      });
      return res.status(200).json({ success: true, data: readiness });
    } catch (error) {
      return respondError(res, error);
    }
  }

static async evaluate(req, res) {
    try {
      const payload = await evaluateBookingSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const result = await evaluateBookingEligibility({ business, ...payload });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return respondError(res, error);
    }
  }
}
