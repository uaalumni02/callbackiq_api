/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbbusiness1Methods(deps) {
  const { BUSINESS_SCOPE_FIELDS, safeConsole } = deps;
  return {
async getBusinessScopeByOwner(model, ownerId) {
    try {
      return await model
        .findOne({ owner: ownerId })
        .select(BUSINESS_SCOPE_FIELDS)
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching business scope by owner:", error);
      throw error;
    }
  },

async updateBusiness(model, id, data) {
    try {
      return await model
        .findByIdAndUpdate(id, data, {
          returnDocument: "after",
          runValidators: true,
        })
        .populate("owner", "userName email role");
    } catch (error) {
      safeConsole.error("Error updating business:", error);
      throw error;
    }
  },

async updateBusinessByOwner(model, ownerId, data) {
    try {
      return await model
        .findOneAndUpdate(
          {
            owner: ownerId,
          },
          data,
          {
            returnDocument: "after",
            runValidators: true,
          },
        )
        .populate("owner", "userName email role");
    } catch (error) {
      safeConsole.error("Error updating business by owner:", error);
      throw error;
    }
  },

async deleteBusinessByOwner(model, ownerId) {
    try {
      const { deleteBusinessSafely } = await import(
        "../../../services/businessDeletion.service.js"
      );
      return await deleteBusinessSafely({ ownerId });
    } catch (error) {
      safeConsole.error("Error deleting business by owner:", error);
      throw error;
    }
  },

async deleteBusiness(model, id) {
    try {
      const { deleteBusinessSafely } = await import(
        "../../../services/businessDeletion.service.js"
      );
      return await deleteBusinessSafely({ businessId: id });
    } catch (error) {
      safeConsole.error("Error deleting business:", error);
      throw error;
    }
  },

async getBusinessByPhone(model, phone) {
    try {
      return await model.findOne({
        $or: [
          { phone },
          { businessPhone: phone },
          { twilioPhoneNumber: phone },
        ],
      });
    } catch (error) {
      safeConsole.error("Error fetching business by phone:", error);
      throw error;
    }
  },

async getBusinessByPhoneForWebhook(model, phone) {
    try {
      return await model
        .findOne({
          isActive: true,
          "trackingNumber.status": "active",
          $or: [{ phone }, { phoneLookup: phone }],
        })
        .select(BUSINESS_SCOPE_FIELDS);
    } catch (error) {
      safeConsole.error("Error fetching webhook business by phone:", error);
      throw error;
    }
  },

async adminUpdateBusinessStatus({ Business, businessId, isActive }) {
    try {
      return await Business.findByIdAndUpdate(
        businessId,
        { isActive },
        {
          returnDocument: "after",
          runValidators: true,
        },
      ).populate("owner", "userName email role");
    } catch (error) {
      safeConsole.error("Error updating business status as admin:", error);
      throw error;
    }
  }
  };
}
