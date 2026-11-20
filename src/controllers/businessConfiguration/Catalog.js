import ServiceOffering from "../../models/serviceOffering.js";
import { createServiceOfferingSchema, updateServiceOfferingSchema } from "../../validator/businessConfiguration.js";
import { getBusinessConfigurationBootstrap } from "../../services/businessConfiguration.service.js";
import { getOwnerBusiness, respondError, respondNotFound } from "./helpers.js";

export default class BusinessConfigurationCatalogController {
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
}
