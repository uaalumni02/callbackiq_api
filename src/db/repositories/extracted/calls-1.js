/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbcalls1Methods(deps) {
  const { safeConsole } = deps;
  return {
async getCallLogsByBusiness(model, businessId) {
    try {
      return await model
        .find({ business: businessId })
        .sort({ createdAt: -1 })
        .populate(
          "business",
          "businessName businessType phone smsTemplate estimatedJobValue",
        )
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility")
        .populate("conversation", "customerPhone customerName status")
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching call logs:", error);
      throw error;
    }
  },

async getCallLogById(model, id) {
    try {
      return await model
        .findById(id)
        .populate(
          "business",
          "businessName businessType phone smsTemplate estimatedJobValue",
        )
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      safeConsole.error("Error fetching call log:", error);
      throw error;
    }
  },

async getCallLogForBusiness(model, id, businessId) {
    try {
      return await model
        .findOne({
          _id: id,
          business: businessId,
        })
        .populate(
          "business",
          "businessName businessType phone smsTemplate estimatedJobValue",
        )
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility")
        .populate("conversation", "customerPhone customerName status")
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching call log for business:", error);
      throw error;
    }
  },

async updateCallLog(model, id, data) {
    try {
      return await model
        .findByIdAndUpdate(id, data, {
          returnDocument: "after",
          runValidators: true,
        })
        .populate(
          "business",
          "businessName businessType phone smsTemplate estimatedJobValue",
        )
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      safeConsole.error("Error updating call log:", error);
      throw error;
    }
  },

async updateCallLogForBusiness(model, id, businessId, data) {
    try {
      return await model
        .findOneAndUpdate(
          {
            _id: id,
            business: businessId,
          },
          data,
          {
            returnDocument: "after",
            runValidators: true,
          },
        )
        .populate(
          "business",
          "businessName businessType phone smsTemplate estimatedJobValue",
        )
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      safeConsole.error("Error updating call log for business:", error);
      throw error;
    }
  },

async updateCallLogByProviderCallId(model, providerCallId, data) {
    try {
      return await model
        .findOneAndUpdate({ providerCallId }, data, {
          returnDocument: "after",
          runValidators: true,
        })
        .populate(
          "business",
          "businessName phone smsTemplate estimatedJobValue",
        )
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      safeConsole.error("Error updating call log by providerCallId:", error);
      throw error;
    }
  }
  };
}
