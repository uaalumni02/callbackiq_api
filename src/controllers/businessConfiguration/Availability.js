import { AvailabilityException, AvailabilityRule, availabilityRulesSchema, createAvailabilityExceptionSchema, getOwnerBusiness, respondError, respondNotFound, updateAvailabilityExceptionSchema } from './context.js';

export default class BusinessConfigurationAvailabilityController {
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
}
