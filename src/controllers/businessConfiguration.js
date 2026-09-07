import { safeConsole } from "../helpers/logging/safeLogger.js";
import Business from "../models/business.js";
import AvailabilityException from "../models/availabilityException.js";
import AvailabilityRule from "../models/availabilityRule.js";
import BusinessOperationsSettings from "../models/businessOperationsSettings.js";
import SchedulingPolicy from "../models/schedulingPolicy.js";
import ServiceArea from "../models/serviceArea.js";
import ServiceOffering from "../models/serviceOffering.js";
import {
  getBusinessConfigurationBootstrap,
  getConfigurationReadiness,
} from "../services/businessConfiguration.service.js";
import { evaluateBookingEligibility } from "../services/bookingEligibility.service.js";
import {
  availabilityRulesSchema,
  createAvailabilityExceptionSchema,
  createServiceOfferingSchema,
  evaluateBookingSchema,
  operationsSettingsSchema,
  schedulingPolicySchema,
  serviceAreaSchema,
  updateAvailabilityExceptionSchema,
  updateServiceOfferingSchema,
} from "../validator/businessConfiguration.js";

const getOwnerBusiness = async (req) => {
  const ownerId = req.user?.userId;
  if (!ownerId) return null;
  return Business.findOne({ owner: ownerId });
};

const respondNotFound = (res, message = "Business not found") =>
  res.status(404).json({ success: false, message });

const respondError = (res, error) => {
  if (error?.isJoi) {
    return res.status(400).json({
      success: false,
      message: error.details?.[0]?.message || error.message,
    });
  }

  if (error?.name === "CastError") {
    return res.status(400).json({ success: false, message: "Invalid identifier" });
  }

  if (error?.code === 11000) {
    return res.status(409).json({
      success: false,
      message: "A configuration record with these values already exists",
    });
  }

  safeConsole.error("Business configuration error:", error);
  return res.status(500).json({
    success: false,
    message: "Unable to process business configuration",
  });
};

class BusinessConfigurationController {
  static async bootstrap(req, res) {
    try {
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const data = await getBusinessConfigurationBootstrap(business);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return respondError(res, error);
    }
  }

  static async listServices(req, res) {
    try {
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const services = await ServiceOffering.find({ business: business._id }).sort({
        active: -1,
        name: 1,
      });
      return res.status(200).json({ success: true, data: services });
    } catch (error) {
      return respondError(res, error);
    }
  }

  static async createService(req, res) {
    try {
      const payload = await createServiceOfferingSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const service = await ServiceOffering.create({
        ...payload,
        business: business._id,
      });
      return res.status(201).json({
        success: true,
        message: "Service offering created",
        data: service,
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

  static async updateService(req, res) {
    try {
      const payload = await updateServiceOfferingSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const service = await ServiceOffering.findOneAndUpdate(
        { _id: req.params.serviceId, business: business._id },
        { $set: payload },
        { returnDocument: "after", runValidators: true },
      );
      if (!service) return respondNotFound(res, "Service offering not found");

      return res.status(200).json({
        success: true,
        message: "Service offering updated",
        data: service,
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

  static async deleteService(req, res) {
    try {
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const service = await ServiceOffering.findOneAndDelete({
        _id: req.params.serviceId,
        business: business._id,
      });
      if (!service) return respondNotFound(res, "Service offering not found");

      return res.status(200).json({
        success: true,
        message: "Service offering deleted",
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

  static async getAvailability(req, res) {
    try {
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const [rules, exceptions] = await Promise.all([
        AvailabilityRule.find({ business: business._id }).sort({ dayOfWeek: 1 }),
        AvailabilityException.find({ business: business._id, active: true }).sort({
          date: 1,
        }),
      ]);
      return res.status(200).json({
        success: true,
        data: { rules, exceptions },
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

  static async replaceAvailabilityRules(req, res) {
    try {
      const { rules } = await availabilityRulesSchema.validateAsync(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      await Promise.all(
        rules.map((rule) =>
          AvailabilityRule.findOneAndUpdate(
            { business: business._id, dayOfWeek: rule.dayOfWeek },
            { $set: { ...rule, business: business._id } },
            {
              upsert: true,
              returnDocument: "after",
              runValidators: true,
              setDefaultsOnInsert: true,
            },
          ),
        ),
      );

      const saved = await AvailabilityRule.find({ business: business._id }).sort({
        dayOfWeek: 1,
      });
      return res.status(200).json({
        success: true,
        message: "Availability rules saved",
        data: saved,
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

  static async createAvailabilityException(req, res) {
    try {
      const payload = await createAvailabilityExceptionSchema.validateAsync(
        req.body,
        { abortEarly: false, stripUnknown: true },
      );
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const exception = await AvailabilityException.create({
        ...payload,
        business: business._id,
      });
      return res.status(201).json({
        success: true,
        message: "Availability exception created",
        data: exception,
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

  static async updateAvailabilityException(req, res) {
    try {
      const payload = await updateAvailabilityExceptionSchema.validateAsync(
        req.body,
        { abortEarly: false, stripUnknown: true },
      );
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const exception = await AvailabilityException.findOneAndUpdate(
        { _id: req.params.exceptionId, business: business._id },
        { $set: payload },
        { returnDocument: "after", runValidators: true },
      );
      if (!exception) return respondNotFound(res, "Availability exception not found");

      return res.status(200).json({
        success: true,
        message: "Availability exception updated",
        data: exception,
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

  static async deleteAvailabilityException(req, res) {
    try {
      const business = await getOwnerBusiness(req);
      if (!business) return respondNotFound(res);

      const exception = await AvailabilityException.findOneAndDelete({
        _id: req.params.exceptionId,
        business: business._id,
      });
      if (!exception) return respondNotFound(res, "Availability exception not found");

      return res.status(200).json({
        success: true,
        message: "Availability exception deleted",
      });
    } catch (error) {
      return respondError(res, error);
    }
  }

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
      return res.status(200).json({
        success: true,
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

export default BusinessConfigurationController;
