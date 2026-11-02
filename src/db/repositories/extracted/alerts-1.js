/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbalerts1Methods(deps) {
  const { safeConsole } = deps;
  return {
async getAlertsByBusiness(model, businessId) {
    try {
      return await model
        .find({ business: businessId })
        .sort({ createdAt: -1 })
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility")
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching alerts by business:", error);
      throw error;
    }
  },

async getUnreadAlertsByBusiness(model, businessId) {
    try {
      return await model
        .find({
          business: businessId,
          readAt: null,
        })
        .sort({ createdAt: -1 })
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility")
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching unread alerts:", error);
      throw error;
    }
  },

async getAlertById(model, id) {
    try {
      return await model
        .findById(id)
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility");
    } catch (error) {
      safeConsole.error("Error fetching alert by ID:", error);
      throw error;
    }
  },

async getAlertForBusiness(model, id, businessId) {
    try {
      return await model
        .findOne({
          _id: id,
          business: businessId,
        })
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility");
    } catch (error) {
      safeConsole.error("Error fetching alert for business:", error);
      throw error;
    }
  },

async updateAlert(model, id, data) {
    try {
      return await model
        .findByIdAndUpdate(id, data, {
          returnDocument: "after",
          runValidators: true,
        })
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility");
    } catch (error) {
      safeConsole.error("Error updating alert:", error);
      throw error;
    }
  },

async updateAlertForBusiness(model, id, businessId, data) {
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
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility");
    } catch (error) {
      safeConsole.error("Error updating alert for business:", error);
      throw error;
    }
  },

async markAlertAsRead(model, id) {
    try {
      return await model
        .findByIdAndUpdate(
          id,
          {
            $set: {
              status: "read",
              readAt: new Date(),
            },
          },
          {
            returnDocument: "after",
            runValidators: true,
          },
        )
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility");
    } catch (error) {
      safeConsole.error("Error marking alert as read:", error);
      throw error;
    }
  },

async markAlertAsReadForBusiness(model, id, businessId) {
    try {
      return await model
        .findOneAndUpdate(
          {
            _id: id,
            business: businessId,
          },
          {
            $set: {
              status: "read",
              readAt: new Date(),
            },
          },
          {
            returnDocument: "after",
            runValidators: true,
          },
        )
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility");
    } catch (error) {
      safeConsole.error("Error marking business alert as read:", error);
      throw error;
    }
  },

async markAllAlertsAsRead(model, businessId, readAt = new Date()) {
    try {
      return await model.updateMany(
        {
          business: businessId,
          readAt: null,
        },
        {
          $set: {
            status: "read",
            readAt,
          },
        },
      );
    } catch (error) {
      safeConsole.error("Error marking all alerts as read:", error);
      throw error;
    }
  }
  };
}
