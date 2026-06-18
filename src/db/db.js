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
  // ----- Call Log methods -----

  static async saveCallLog(model, data) {
    try {
      const callLog = new model(data);
      return await callLog.save();
    } catch (error) {
      console.error("Error saving call log:", error);
      throw error;
    }
  }

  static async getCallLogsByBusiness(model, businessId) {
    try {
      return await model
        .find({ business: businessId })
        .sort({ createdAt: -1 })
        .populate(
          "business",
          "businessName businessType phone smsTemplate estimatedJobValue",
        )
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      console.error("Error fetching call logs:", error);
      throw error;
    }
  }

  static async getCallLogById(model, id) {
    try {
      return await model
        .findById(id)
        .populate(
          "business",
          "businessName businessType phone smsTemplate estimatedJobValue",
        )
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      console.error("Error fetching call log:", error);
      throw error;
    }
  }

  static async updateCallLog(model, id, data) {
    try {
      return await model
        .findByIdAndUpdate(id, data, {
          new: true,
          runValidators: true,
        })
        .populate(
          "business",
          "businessName businessType phone smsTemplate estimatedJobValue",
        )
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      console.error("Error updating call log:", error);
      throw error;
    }
  }

  static async deleteCallLog(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      console.error("Error deleting call log:", error);
      throw error;
    }
  }
  // ----- Twilio helper methods -----

  static async getBusinessByPhone(model, phone) {
    try {
      return await model.findOne({
        $or: [
          { phone },
          { businessPhone: phone },
          { twilioPhoneNumber: phone },
        ],
      });
    } catch (error) {
      console.error("Error fetching business by phone:", error);
      throw error;
    }
  }

  static async getFirstBusiness(model) {
    try {
      return await model.findOne({}).sort({ createdAt: 1 });
    } catch (error) {
      console.error("Error fetching first business:", error);
      throw error;
    }
  }

  static async getLeadByBusinessAndPhone(model, businessId, phone) {
    try {
      return await model.findOne({
        business: businessId,
        phone,
      });
    } catch (error) {
      console.error("Error fetching lead by business and phone:", error);
      throw error;
    }
  }

  static async getConversationByBusinessAndPhone(model, businessId, phone) {
    try {
      return await model.findOne({
        business: businessId,
        customerPhone: phone,
      });
    } catch (error) {
      console.error(
        "Error fetching conversation by business and phone:",
        error,
      );
      throw error;
    }
  }

  static async updateCallLogByProviderCallId(model, providerCallId, data) {
    try {
      return await model
        .findOneAndUpdate({ providerCallId }, data, {
          new: true,
          runValidators: true,
        })
        .populate(
          "business",
          "businessName phone smsTemplate estimatedJobValue",
        )
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      console.error("Error updating call log by providerCallId:", error);
      throw error;
    }
  }
  // ----- Dashboard methods -----

  static async getDashboardMetrics({
    Business,
    Lead,
    CallLog,
    Conversation,
    Message,
    ownerId,
    businessId,
  }) {
    try {
      const businessQuery = businessId
        ? { _id: businessId, owner: ownerId }
        : { owner: ownerId };

      const business = await Business.findOne(businessQuery);

      if (!business) {
        return null;
      }

      const scopedBusinessId = business._id;

      const missedCallStatuses = ["missed", "no_answer", "busy", "failed"];

      const [
        totalCalls,
        missedCalls,
        answeredCalls,
        recoveredCalls,
        totalLeads,
        newLeads,
        contactedLeads,
        bookedLeads,
        lostLeads,
        spamLeads,
        activeConversations,
        closedConversations,
        smsSent,
        smsReceived,
        bookedRevenueAgg,
        recoveredRevenueAgg,
      ] = await Promise.all([
        CallLog.countDocuments({ business: scopedBusinessId }),

        CallLog.countDocuments({
          business: scopedBusinessId,
          status: { $in: missedCallStatuses },
        }),

        CallLog.countDocuments({
          business: scopedBusinessId,
          status: "answered",
        }),

        CallLog.countDocuments({
          business: scopedBusinessId,
          recovered: true,
        }),

        Lead.countDocuments({ business: scopedBusinessId }),

        Lead.countDocuments({ business: scopedBusinessId, status: "new" }),

        Lead.countDocuments({
          business: scopedBusinessId,
          status: "contacted",
        }),

        Lead.countDocuments({ business: scopedBusinessId, status: "booked" }),

        Lead.countDocuments({ business: scopedBusinessId, status: "lost" }),

        Lead.countDocuments({ business: scopedBusinessId, status: "spam" }),

        Conversation.countDocuments({
          business: scopedBusinessId,
          status: "open",
        }),

        Conversation.countDocuments({
          business: scopedBusinessId,
          status: "closed",
        }),

        Message.countDocuments({
          business: scopedBusinessId,
          direction: "outbound",
        }),

        Message.countDocuments({
          business: scopedBusinessId,
          direction: "inbound",
        }),

        Lead.aggregate([
          {
            $match: {
              business: scopedBusinessId,
              status: "booked",
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$estimatedValue" },
            },
          },
        ]),

        Lead.aggregate([
          {
            $match: {
              business: scopedBusinessId,
              status: { $in: ["contacted", "booked"] },
              source: { $in: ["missed_call", "sms"] },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$estimatedValue" },
            },
          },
        ]),
      ]);

      const bookedRevenue = bookedRevenueAgg?.[0]?.total || 0;
      const recoveredRevenue = recoveredRevenueAgg?.[0]?.total || 0;

      const missedCallRecoveryRate =
        missedCalls > 0 ? Math.round((recoveredCalls / missedCalls) * 100) : 0;

      const bookingRate =
        totalLeads > 0 ? Math.round((bookedLeads / totalLeads) * 100) : 0;

      return {
        business: {
          _id: business._id,
          businessName: business.businessName,
          businessType: business.businessType,
          phone: business.phone,
          estimatedJobValue: business.estimatedJobValue,
        },

        calls: {
          totalCalls,
          missedCalls,
          answeredCalls,
          recoveredCalls,
          missedCallRecoveryRate,
        },

        leads: {
          totalLeads,
          newLeads,
          contactedLeads,
          bookedLeads,
          lostLeads,
          spamLeads,
          bookingRate,
        },

        conversations: {
          activeConversations,
          closedConversations,
        },

        messages: {
          smsSent,
          smsReceived,
          totalMessages: smsSent + smsReceived,
        },

        revenue: {
          bookedRevenue,
          recoveredRevenue,
        },
      };
    } catch (error) {
      console.error("Error getting dashboard metrics:", error);
      throw error;
    }
  }
  // ----- AI methods -----

  static async getLeadForBusiness(model, leadId, businessId) {
    try {
      return await model.findOne({
        _id: leadId,
        business: businessId,
      });
    } catch (error) {
      console.error("Error fetching lead for business:", error);
      throw error;
    }
  }

  static async qualifyLead(model, leadId, data) {
    try {
      return await model
        .findByIdAndUpdate(leadId, data, {
          new: true,
          runValidators: true,
        })
        .populate(
          "business",
          "businessName businessType phone estimatedJobValue",
        );
    } catch (error) {
      console.error("Error qualifying lead:", error);
      throw error;
    }
  }
  // ----- Alert methods -----

  static async saveAlert(model, data) {
    try {
      const alert = new model(data);
      return await alert.save();
    } catch (error) {
      console.error("Error saving alert:", error);
      throw error;
    }
  }

  static async getAlertsByBusiness(model, businessId) {
    try {
      return await model
        .find({ business: businessId })
        .sort({ createdAt: -1 })
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status");
    } catch (error) {
      console.error("Error fetching alerts by business:", error);
      throw error;
    }
  }

  static async getUnreadAlertsByBusiness(model, businessId) {
    try {
      return await model
        .find({
          business: businessId,
          status: { $ne: "read" },
        })
        .sort({ createdAt: -1 })
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status");
    } catch (error) {
      console.error("Error fetching unread alerts:", error);
      throw error;
    }
  }

  static async getAlertById(model, id) {
    try {
      return await model
        .findById(id)
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status");
    } catch (error) {
      console.error("Error fetching alert by ID:", error);
      throw error;
    }
  }

  static async updateAlert(model, id, data) {
    try {
      return await model
        .findByIdAndUpdate(id, data, {
          new: true,
          runValidators: true,
        })
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status");
    } catch (error) {
      console.error("Error updating alert:", error);
      throw error;
    }
  }

  static async markAlertAsRead(model, id) {
    try {
      return await model
        .findByIdAndUpdate(
          id,
          {
            status: "read",
            readAt: new Date(),
          },
          {
            new: true,
            runValidators: true,
          },
        )
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status");
    } catch (error) {
      console.error("Error marking alert as read:", error);
      throw error;
    }
  }

  static async markAllAlertsAsRead(model, businessId) {
    try {
      return await model.updateMany(
        {
          business: businessId,
          status: { $ne: "read" },
        },
        {
          status: "read",
          readAt: new Date(),
        },
      );
    } catch (error) {
      console.error("Error marking all alerts as read:", error);
      throw error;
    }
  }

  static async deleteAlert(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      console.error("Error deleting alert:", error);
      throw error;
    }
  }
  // ----- Subscription / Billing methods -----

  static async getSubscriptionByBusiness(model, businessId) {
    try {
      return await model
        .findOne({ business: businessId })
        .populate("business", "businessName businessType phone email");
    } catch (error) {
      console.error("Error fetching subscription by business:", error);
      throw error;
    }
  }

  static async getSubscriptionByStripeCustomer(model, stripeCustomerId) {
    try {
      return await model
        .findOne({ stripeCustomerId })
        .populate("business", "businessName businessType phone email");
    } catch (error) {
      console.error("Error fetching subscription by Stripe customer:", error);
      throw error;
    }
  }

  static async getSubscriptionByStripeSubscription(
    model,
    stripeSubscriptionId,
  ) {
    try {
      return await model
        .findOne({ stripeSubscriptionId })
        .populate("business", "businessName businessType phone email");
    } catch (error) {
      console.error(
        "Error fetching subscription by Stripe subscription:",
        error,
      );
      throw error;
    }
  }

  static async upsertSubscriptionByBusiness(model, businessId, data) {
    try {
      return await model
        .findOneAndUpdate(
          { business: businessId },
          {
            ...data,
            business: businessId,
          },
          {
            new: true,
            upsert: true,
            runValidators: true,
            setDefaultsOnInsert: true,
          },
        )
        .populate("business", "businessName businessType phone email");
    } catch (error) {
      console.error("Error upserting subscription:", error);
      throw error;
    }
  }

  static async updateSubscriptionByStripeSubscription(
    model,
    stripeSubscriptionId,
    data,
  ) {
    try {
      return await model
        .findOneAndUpdate({ stripeSubscriptionId }, data, {
          new: true,
          runValidators: true,
        })
        .populate("business", "businessName businessType phone email");
    } catch (error) {
      console.error(
        "Error updating subscription by Stripe subscription:",
        error,
      );
      throw error;
    }
  }
}

export default Db;
