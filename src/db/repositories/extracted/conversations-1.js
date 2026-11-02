/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbconversations1Methods(deps) {
  const { safeConsole } = deps;
  return {
async getConversationsByBusiness(model, businessId) {
    try {
      return await model
        .find({ business: businessId })
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .populate("business", "businessName phone owner")
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility")
        .populate("archivedBy", "userName email role")
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching conversations:", error);
      throw error;
    }
  },

async getConversationById(
    model,
    id,
    {
      populateBusiness = true,
      populateLead = true,
      populateArchivedBy = true,
      lean = false,
      select = null,
    } = {},
  ) {
    try {
      let query = model.findById(id);

      if (select) {
        query = query.select(select);
      }

      if (populateBusiness) {
        query = query.populate(
          "business",
          "businessName phone owner",
        );
      }

      if (populateLead) {
        query = query.populate(
          "lead",
          "customerName phone serviceNeeded urgency status serviceEligibility",
        );
      }

      if (populateArchivedBy) {
        query = query.populate(
          "archivedBy",
          "userName email role",
        );
      }

      if (lean) {
        query = query.lean();
      }

      return await query;
    } catch (error) {
      safeConsole.error("Error fetching conversation:", error);
      throw error;
    }
  },

async getConversationForBusiness(model, id, businessId) {
    try {
      return await model
        .findOne({
          _id: id,
          business: businessId,
        })
        .populate("business", "businessName phone owner")
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility")
        .populate("archivedBy", "userName email role")
        .lean();
    } catch (error) {
      safeConsole.error("Error fetching conversation for business:", error);
      throw error;
    }
  },

async updateConversation(model, id, data) {
    try {
      return await model
        .findByIdAndUpdate(id, data, {
          returnDocument: "after",
          runValidators: true,
        })
        .populate("business", "businessName phone owner")
        .populate("lead", "customerName phone serviceNeeded urgency status serviceEligibility")
        .populate("archivedBy", "userName email role");
    } catch (error) {
      safeConsole.error("Error updating conversation:", error);
      throw error;
    }
  },

async getConversationByBusinessAndPhone(model, businessId, phone) {
    try {
      return await model
        .findOne({
          business: businessId,
          customerPhone: phone,
        })
        .sort({ lastMessageAt: -1, createdAt: -1 });
    } catch (error) {
      safeConsole.error(
        "Error fetching conversation by business and phone:",
        error,
      );
      throw error;
    }
  }
  };
}
