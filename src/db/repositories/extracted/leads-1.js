/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbleads1Methods(deps) {
  const { safeConsole } = deps;
  return {
async getLeadsByBusiness(model, businessId) {
    try {
      return await model
        .find({ business: businessId })
        .sort({ createdAt: -1 })
        .populate("business", "businessName businessType phone")
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching leads by business:", error);
      throw error;
    }
  },

async getLeadById(
    model,
    id,
    {
      populateBusiness = true,
      lean = false,
    } = {},
  ) {
    try {
      let query = model.findById(id);

      if (populateBusiness) {
        query = query.populate(
          "business",
          "businessName businessType phone",
        );
      }

      if (lean) {
        query = query.lean();
      }

      return await query;
    } catch (error) {
      safeConsole.error("Error fetching lead by ID:", error);
      throw error;
    }
  },

async updateLead(model, id, data) {
    try {
      return await model
        .findByIdAndUpdate(id, data, {
          returnDocument: "after",
          runValidators: true,
        })
        .populate("business", "businessName businessType phone");
    } catch (error) {
      safeConsole.error("Error updating lead:", error);
      throw error;
    }
  },

async updateLeadForBusiness(model, id, businessId, data) {
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
        .populate("business", "businessName businessType phone");
    } catch (error) {
      safeConsole.error("Error updating lead for business:", error);
      throw error;
    }
  },

async getLeadByBusinessAndPhone(model, businessId, phone) {
    try {
      return await model
        .findOne({
          business: businessId,
          phone,
        })
        .sort({ createdAt: -1 });
    } catch (error) {
      safeConsole.error("Error fetching lead by business and phone:", error);
      throw error;
    }
  },

async qualifyLead(model, leadId, data) {
    try {
      return await model
        .findByIdAndUpdate(leadId, data, {
          returnDocument: "after",
          runValidators: true,
        })
        .populate(
          "business",
          "businessName businessType phone estimatedJobValue",
        );
    } catch (error) {
      safeConsole.error("Error qualifying lead:", error);
      throw error;
    }
  }
  };
}
