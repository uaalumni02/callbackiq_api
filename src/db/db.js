class Db {
  static async findUserByEmailOrUserName(model, userName, email) {
    try {
      return await model.findOne({
        $or: [{ userName }, { email }],
      });
    } catch (error) {
      throw new Error("Database error while finding user");
    }
  }

  static async findUserByLogin(model, login) {
    try {
      return await model.findOne({
        $or: [{ userName: login }, { email: login }],
      });
    } catch (error) {
      throw new Error("Database error while finding user");
    }
  }

  static async saveUser(model, userData) {
    try {
      const user = new model(userData);
      return await user.save();
    } catch (error) {
      console.error("Actual Mongoose Save Error:", error);
      throw error;
    }
  }

  static async getUserById(model, id) {
    try {
      return await model.findById(id).select("-password");
    } catch (error) {
      throw new Error("Database error while fetching user");
    }
  }
  // ----- Business methods -----

  static async saveBusiness(model, data) {
    try {
      const business = new model(data);
      return await business.save();
    } catch (error) {
      console.error("Error saving business:", error);
      throw error;
    }
  }

  static async getBusinessByOwner(model, ownerId) {
    try {
      return await model
        .findOne({ owner: ownerId })
        .populate("owner", "userName email role");
    } catch (error) {
      console.error("Error fetching business by owner:", error);
      throw error;
    }
  }

  static async getBusinessById(model, id) {
    try {
      return await model.findById(id).populate("owner", "userName email role");
    } catch (error) {
      console.error("Error fetching business by ID:", error);
      throw error;
    }
  }

  static async getAllBusinesses(model) {
    try {
      return await model
        .find({})
        .sort({ createdAt: -1 })
        .populate("owner", "userName email role");
    } catch (error) {
      console.error("Error fetching businesses:", error);
      throw error;
    }
  }

  static async updateBusiness(model, id, data) {
    try {
      return await model
        .findByIdAndUpdate(id, data, {
          new: true,
          runValidators: true,
        })
        .populate("owner", "userName email role");
    } catch (error) {
      console.error("Error updating business:", error);
      throw error;
    }
  }

  static async deleteBusiness(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      console.error("Error deleting business:", error);
      throw error;
    }
  }
  // ----- Lead methods -----

  static async saveLead(model, data) {
    try {
      const lead = new model(data);
      return await lead.save();
    } catch (error) {
      console.error("Error saving lead:", error);
      throw error;
    }
  }

  static async getLeadsByBusiness(model, businessId) {
    try {
      return await model
        .find({ business: businessId })
        .sort({ createdAt: -1 })
        .populate("business", "businessName businessType phone");
    } catch (error) {
      console.error("Error fetching leads by business:", error);
      throw error;
    }
  }

  static async getLeadById(model, id) {
    try {
      return await model
        .findById(id)
        .populate("business", "businessName businessType phone");
    } catch (error) {
      console.error("Error fetching lead by ID:", error);
      throw error;
    }
  }

  static async updateLead(model, id, data) {
    try {
      return await model
        .findByIdAndUpdate(id, data, {
          new: true,
          runValidators: true,
        })
        .populate("business", "businessName businessType phone");
    } catch (error) {
      console.error("Error updating lead:", error);
      throw error;
    }
  }

  static async deleteLead(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      console.error("Error deleting lead:", error);
      throw error;
    }
  }
  // ----- Conversation methods -----

  static async saveConversation(model, data) {
    try {
      const conversation = new model(data);
      return await conversation.save();
    } catch (error) {
      console.error("Error saving conversation:", error);
      throw error;
    }
  }

  static async getConversationsByBusiness(model, businessId) {
    try {
      return await model
        .find({ business: businessId })
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .populate("business", "businessName phone")
        .populate("lead", "customerName phone serviceNeeded urgency status");
    } catch (error) {
      console.error("Error fetching conversations:", error);
      throw error;
    }
  }

  static async getConversationById(model, id) {
    try {
      return await model
        .findById(id)
        .populate("business", "businessName phone")
        .populate("lead", "customerName phone serviceNeeded urgency status");
    } catch (error) {
      console.error("Error fetching conversation:", error);
      throw error;
    }
  }

  static async updateConversation(model, id, data) {
    try {
      return await model
        .findByIdAndUpdate(id, data, {
          new: true,
          runValidators: true,
        })
        .populate("business", "businessName phone")
        .populate("lead", "customerName phone serviceNeeded urgency status");
    } catch (error) {
      console.error("Error updating conversation:", error);
      throw error;
    }
  }

  static async deleteConversation(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      console.error("Error deleting conversation:", error);
      throw error;
    }
  }

  // ----- Message methods -----

  static async saveMessage(model, data) {
    try {
      const message = new model(data);
      return await message.save();
    } catch (error) {
      console.error("Error saving message:", error);
      throw error;
    }
  }

  static async getMessagesByConversation(model, conversationId) {
    try {
      return await model
        .find({ conversation: conversationId })
        .sort({ createdAt: 1 })
        .populate("lead", "customerName phone serviceNeeded")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      console.error("Error fetching messages:", error);
      throw error;
    }
  }

  static async getMessageById(model, id) {
    try {
      return await model
        .findById(id)
        .populate("lead", "customerName phone serviceNeeded")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      console.error("Error fetching message:", error);
      throw error;
    }
  }

  static async deleteMessage(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      console.error("Error deleting message:", error);
      throw error;
    }
  }
}

export default Db;
