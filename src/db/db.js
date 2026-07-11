import { formatCustomerRow } from "../helpers/model/admin.js";

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

  // ----- Password Reset methods -----

  static async findUserByEmail(model, email) {
    try {
      return await model.findOne({ email });
    } catch (error) {
      console.error("Error finding user by email:", error);
      throw error;
    }
  }

  static async savePasswordResetToken(model, userId, resetToken, expiresAt) {
    try {
      return await model.findByIdAndUpdate(
        userId,
        {
          resetToken,
          resetTokenExpiresAt: expiresAt,
        },
        {
          returnDocument: "after",
          runValidators: true,
        },
      );
    } catch (error) {
      console.error("Error saving password reset token:", error);
      throw error;
    }
  }

  static async findUserByPasswordResetToken(model, resetToken) {
    try {
      return await model
        .findOne({
          resetToken,
          resetTokenExpiresAt: { $gt: new Date() },
        })
        .select("+password +resetToken +resetTokenExpiresAt");
    } catch (error) {
      console.error("Error finding password reset token:", error);
      throw error;
    }
  }

  static async saveResetPassword(model, userId, password) {
    try {
      return await model.findByIdAndUpdate(
        userId,
        {
          password,
          resetToken: null,
          resetTokenExpiresAt: null,

          failedLoginAttempts: 0,
          lastFailedLoginAt: null,
          loginBlockedUntil: null,
          loginLockoutLevel: 0,
          lastLoginLockoutAt: null,
          securityChallengeRequired: false,
          securityChallengeRequiredAt: null,
        },
        {
          returnDocument: "after",
          runValidators: true,
        },
      );
    } catch (error) {
      console.error("Error saving reset password:", error);
      throw error;
    }
  }

  static async findUserByLogin(model, login) {
    try {
      const normalizedLogin = String(login || "").trim();
      const normalizedEmail = normalizedLogin.toLowerCase();

      return await model
        .findOne({
          $or: [{ userName: normalizedLogin }, { email: normalizedEmail }],
        })
        .select(
          [
            "+password",
            "+failedLoginAttempts",
            "+lastFailedLoginAt",
            "+loginBlockedUntil",
            "+loginLockoutLevel",
            "+lastLoginLockoutAt",
            "+securityChallengeRequired",
            "+securityChallengeRequiredAt",
          ].join(" "),
        );
    } catch (error) {
      console.error("Error finding user by login:", error);
      throw new Error("Database error while finding user");
    }
  }

  /*
   * Records one failed login atomically.
   *
   * Rules:
   * - Failures are counted inside a rolling 15-minute window.
   * - The fifth failure starts a temporary delay.
   * - Each subsequent block increases the delay.
   * - The escalation level resets after 24 hours without a failure.
   * - CAPTCHA becomes required after the third temporary block.
   */
  static async recordFailedLogin(model, userId) {
    try {
      const now = new Date();
      const observationWindowStart = new Date(now.getTime() - 15 * 60 * 1000);
      const decayWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      return await model
        .findOneAndUpdate(
          { _id: userId },
          [
            {
              $set: {
                _existingFailureCount: {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$lastFailedLoginAt", null] },
                        {
                          $gte: ["$lastFailedLoginAt", observationWindowStart],
                        },
                      ],
                    },
                    { $ifNull: ["$failedLoginAttempts", 0] },
                    0,
                  ],
                },

                _existingLockoutLevel: {
                  $cond: [
                    {
                      $or: [
                        { $eq: ["$lastFailedLoginAt", null] },
                        {
                          $lt: ["$lastFailedLoginAt", decayWindowStart],
                        },
                      ],
                    },
                    0,
                    { $ifNull: ["$loginLockoutLevel", 0] },
                  ],
                },
              },
            },

            {
              $set: {
                _nextFailureCount: {
                  $add: ["$_existingFailureCount", 1],
                },
              },
            },

            {
              $set: {
                _shouldBlock: {
                  $gte: ["$_nextFailureCount", 5],
                },

                _nextLockoutLevel: {
                  $cond: [
                    { $gte: ["$_nextFailureCount", 5] },
                    { $add: ["$_existingLockoutLevel", 1] },
                    "$_existingLockoutLevel",
                  ],
                },
              },
            },

            {
              $set: {
                _delayMinutes: {
                  $switch: {
                    branches: [
                      {
                        case: {
                          $eq: ["$_nextLockoutLevel", 1],
                        },
                        then: 1,
                      },
                      {
                        case: {
                          $eq: ["$_nextLockoutLevel", 2],
                        },
                        then: 5,
                      },
                      {
                        case: {
                          $eq: ["$_nextLockoutLevel", 3],
                        },
                        then: 15,
                      },
                      {
                        case: {
                          $eq: ["$_nextLockoutLevel", 4],
                        },
                        then: 30,
                      },
                    ],
                    default: 60,
                  },
                },
              },
            },

            {
              $set: {
                failedLoginAttempts: {
                  $cond: ["$_shouldBlock", 0, "$_nextFailureCount"],
                },

                lastFailedLoginAt: now,

                loginLockoutLevel: "$_nextLockoutLevel",

                loginBlockedUntil: {
                  $cond: [
                    "$_shouldBlock",
                    {
                      $dateAdd: {
                        startDate: now,
                        unit: "minute",
                        amount: "$_delayMinutes",
                      },
                    },
                    {
                      $cond: [
                        {
                          $and: [
                            {
                              $ne: ["$loginBlockedUntil", null],
                            },
                            {
                              $gt: ["$loginBlockedUntil", now],
                            },
                          ],
                        },
                        "$loginBlockedUntil",
                        null,
                      ],
                    },
                  ],
                },

                lastLoginLockoutAt: {
                  $cond: ["$_shouldBlock", now, "$lastLoginLockoutAt"],
                },

                securityChallengeRequired: {
                  $or: [
                    {
                      $eq: [
                        {
                          $ifNull: ["$securityChallengeRequired", false],
                        },
                        true,
                      ],
                    },
                    {
                      $gte: ["$_nextLockoutLevel", 3],
                    },
                  ],
                },

                securityChallengeRequiredAt: {
                  $cond: [
                    {
                      $and: [
                        "$_shouldBlock",
                        {
                          $gte: ["$_nextLockoutLevel", 3],
                        },
                        {
                          $ne: [
                            {
                              $ifNull: ["$securityChallengeRequired", false],
                            },
                            true,
                          ],
                        },
                      ],
                    },
                    now,
                    "$securityChallengeRequiredAt",
                  ],
                },
              },
            },

            {
              $unset: [
                "_existingFailureCount",
                "_existingLockoutLevel",
                "_nextFailureCount",
                "_shouldBlock",
                "_nextLockoutLevel",
                "_delayMinutes",
              ],
            },
          ],
          {
            returnDocument: "after",
            updatePipeline: true,
          },
        )
        .select(
          [
            "+failedLoginAttempts",
            "+lastFailedLoginAt",
            "+loginBlockedUntil",
            "+loginLockoutLevel",
            "+lastLoginLockoutAt",
            "+securityChallengeRequired",
            "+securityChallengeRequiredAt",
          ].join(" "),
        );
    } catch (error) {
      console.error("Error recording failed login:", error);
      throw error;
    }
  }

  static async clearLoginSecurityState(model, userId) {
    try {
      return await model.findByIdAndUpdate(
        userId,
        {
          $set: {
            failedLoginAttempts: 0,
            lastFailedLoginAt: null,
            loginBlockedUntil: null,
            loginLockoutLevel: 0,
            lastLoginLockoutAt: null,
            securityChallengeRequired: false,
            securityChallengeRequiredAt: null,
            lastSuccessfulLoginAt: new Date(),
          },
        },
        {
          returnDocument: "after",
        },
      );
    } catch (error) {
      console.error("Error clearing login security state:", error);
      throw error;
    }
  }

  static async decayLoginSecurityState(model, userId) {
    try {
      const decayWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);

      return await model.findOneAndUpdate(
        {
          _id: userId,
          lastFailedLoginAt: {
            $ne: null,
            $lt: decayWindowStart,
          },
        },
        {
          $set: {
            failedLoginAttempts: 0,
            lastFailedLoginAt: null,
            loginBlockedUntil: null,
            loginLockoutLevel: 0,
            lastLoginLockoutAt: null,
            securityChallengeRequired: false,
            securityChallengeRequiredAt: null,
          },
        },
        {
          returnDocument: "after",
        },
      );
    } catch (error) {
      console.error("Error decaying login security state:", error);
      throw error;
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

  // ----- Support Ticket methods -----

  static async saveSupportTicket(model, data) {
    try {
      const ticket = new model(data);
      return await ticket.save();
    } catch (error) {
      console.error("Error saving support ticket:", error);
      throw error;
    }
  }

  static async getSupportTicketsByBusiness(model, businessId) {
    try {
      return await model
        .find({ business: businessId })
        .sort({ createdAt: -1 })
        .lean();
    } catch (error) {
      console.error("Error fetching support tickets:", error);
      throw error;
    }
  }

  static async getSupportTicketForBusiness(model, ticketId, businessId) {
    try {
      return await model.findOne({ _id: ticketId, business: businessId });
    } catch (error) {
      console.error("Error fetching support ticket:", error);
      throw error;
    }
  }

  static async updateSupportTicketForBusiness(
    model,
    ticketId,
    businessId,
    data,
  ) {
    try {
      return await model.findOneAndUpdate(
        { _id: ticketId, business: businessId },
        data,
        {
          returnDocument: "after",
          runValidators: true,
        },
      );
    } catch (error) {
      console.error("Error updating support ticket:", error);
      throw error;
    }
  }

  static async closeSupportTicketForBusiness(model, ticketId, businessId) {
    try {
      return await model.findOneAndUpdate(
        { _id: ticketId, business: businessId },
        {
          status: "closed",
          resolvedAt: new Date(),
        },
        {
          returnDocument: "after",
          runValidators: true,
        },
      );
    } catch (error) {
      console.error("Error closing support ticket:", error);
      throw error;
    }
  }

  static async getAllSupportTickets(model, filter = {}) {
    try {
      return await model
        .find(filter)
        .populate("business", "businessName phone email businessType")
        .populate("user", "userName email role")
        .populate("lastUpdatedBy", "userName email role")
        .populate("ticketHistory.admin", "userName email role")
        .sort({ createdAt: -1 })
        .lean();
    } catch (error) {
      console.error("Error fetching admin support tickets:", error);
      throw error;
    }
  }

  static async updateSupportTicketAdmin(model, ticketId, updateQuery) {
    try {
      return await model
        .findByIdAndUpdate(ticketId, updateQuery, {
          returnDocument: "after",
          runValidators: true,
        })
        .populate("business", "businessName phone email businessType")
        .populate("user", "userName email role")
        .populate("lastUpdatedBy", "userName email role")
        .populate("ticketHistory.admin", "userName email role");
    } catch (error) {
      console.error("Error updating support ticket as admin:", error);
      throw error;
    }
  }

  // ----- Admin methods -----

  static async getAdminDashboardData({
    User,
    Business,
    Lead,
    CallLog,
    Conversation,
    Message,
    Subscription,
  }) {
    try {
      const [
        users,
        businesses,
        subscriptions,
        totalLeads,
        totalCalls,
        missedCalls,
        totalConversations,
        totalMessages,
      ] = await Promise.all([
        User.find({}).sort({ createdAt: -1 }).lean(),
        Business.find({}).sort({ createdAt: -1 }).lean(),
        Subscription.find({}).lean(),
        Lead.countDocuments(),
        CallLog.countDocuments(),
        CallLog.countDocuments({
          status: { $in: ["missed", "no_answer", "busy", "failed"] },
        }),
        Conversation.countDocuments(),
        Message.countDocuments(),
      ]);

      const ownerMap = new Map(users.map((user) => [String(user._id), user]));

      const subscriptionMap = new Map(
        subscriptions.map((sub) => [String(sub.business), sub]),
      );

      const customers = await Promise.all(
        businesses.map(async (business) => {
          const [
            leadCount,
            callCount,
            missedCallCount,
            conversationCount,
            messageCount,
          ] = await Promise.all([
            Lead.countDocuments({ business: business._id }),
            CallLog.countDocuments({ business: business._id }),
            CallLog.countDocuments({
              business: business._id,
              status: { $in: ["missed", "no_answer", "busy", "failed"] },
            }),
            Conversation.countDocuments({ business: business._id }),
            Message.countDocuments({ business: business._id }),
          ]);

          return formatCustomerRow({
            business,
            owner: ownerMap.get(String(business.owner)),
            subscription: subscriptionMap.get(String(business._id)),
            leadCount,
            callCount,
            missedCallCount,
            conversationCount,
            messageCount,
          });
        }),
      );

      return {
        summary: {
          totalUsers: users.length,
          totalBusinesses: businesses.length,
          activeBusinesses: businesses.filter((b) => b.isActive).length,
          inactiveBusinesses: businesses.filter((b) => !b.isActive).length,
          totalSubscriptions: subscriptions.length,
          activeSubscriptions: subscriptions.filter((s) =>
            ["active", "trialing"].includes(s.status),
          ).length,
          pastDueSubscriptions: subscriptions.filter((s) =>
            ["past_due", "unpaid"].includes(s.status),
          ).length,
          totalLeads,
          totalCalls,
          missedCalls,
          totalConversations,
          totalMessages,
        },
        customers,
        subscriptions,
      };
    } catch (error) {
      console.error("Error getting admin dashboard data:", error);
      throw error;
    }
  }

  static async getAdminCustomerDetails({
    User,
    Business,
    Lead,
    CallLog,
    Conversation,
    Message,
    Subscription,
    businessId,
  }) {
    try {
      const business = await Business.findById(businessId).lean();

      if (!business) {
        return null;
      }

      const [owner, subscription, leads, calls, conversations, messages] =
        await Promise.all([
          User.findById(business.owner).select("-password").lean(),
          Subscription.findOne({ business: businessId }).lean(),
          Lead.find({ business: businessId })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean(),
          CallLog.find({ business: businessId })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean(),
          Conversation.find({ business: businessId })
            .sort({ updatedAt: -1, createdAt: -1 })
            .limit(100)
            .lean(),
          Message.find({ business: businessId })
            .sort({ createdAt: -1 })
            .limit(200)
            .lean(),
        ]);

      const [
        leadCount,
        callCount,
        missedCallCount,
        answeredCallCount,
        recoveredCallCount,
        conversationCount,
        messageCount,
        bookedLeadCount,
        lostLeadCount,
      ] = await Promise.all([
        Lead.countDocuments({ business: businessId }),
        CallLog.countDocuments({ business: businessId }),
        CallLog.countDocuments({
          business: businessId,
          status: { $in: ["missed", "no_answer", "busy", "failed"] },
        }),
        CallLog.countDocuments({
          business: businessId,
          status: "answered",
        }),
        CallLog.countDocuments({
          business: businessId,
          recovered: true,
        }),
        Conversation.countDocuments({ business: businessId }),
        Message.countDocuments({ business: businessId }),
        Lead.countDocuments({
          business: businessId,
          status: "booked",
        }),
        Lead.countDocuments({
          business: businessId,
          status: "lost",
        }),
      ]);

      return {
        business,
        owner,
        subscription: subscription || {
          plan: "none",
          status: "none",
          aiEnabled: false,
        },
        metrics: {
          leads: leadCount,
          calls: callCount,
          missedCalls: missedCallCount,
          answeredCalls: answeredCallCount,
          recoveredCalls: recoveredCallCount,
          conversations: conversationCount,
          messages: messageCount,
          bookedLeads: bookedLeadCount,
          lostLeads: lostLeadCount,
        },
        leads,
        calls,
        conversations,
        messages,
      };
    } catch (error) {
      console.error("Error getting admin customer details:", error);
      throw error;
    }
  }

  static async adminUpdateSubscriptionStatus({
    Subscription,
    businessId,
    status,
  }) {
    try {
      return await Subscription.findOneAndUpdate(
        { business: businessId },
        { business: businessId, status },
        {
          new: true,
          upsert: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      ).populate("business", "businessName businessType phone email");
    } catch (error) {
      console.error("Error updating subscription status as admin:", error);
      throw error;
    }
  }

  static async adminUpdateBusinessStatus({ Business, businessId, isActive }) {
    try {
      return await Business.findByIdAndUpdate(
        businessId,
        { isActive },
        {
          new: true,
          runValidators: true,
        },
      ).populate("owner", "userName email role");
    } catch (error) {
      console.error("Error updating business status as admin:", error);
      throw error;
    }
  }

  static async createAdminActionLog(AdminActionLog, payload) {
    try {
      const log = new AdminActionLog(payload);
      return await log.save();
    } catch (error) {
      console.error("Error creating admin action log:", error);
      throw error;
    }
  }
  // ----- Demo Request methods -----

  static async saveDemoRequest(model, data) {
    try {
      const demoRequest = new model(data);
      return await demoRequest.save();
    } catch (error) {
      console.error("Error saving demo request:", error);
      throw error;
    }
  }

  static async getDemoRequests(model, filter = {}) {
    try {
      return await model.find(filter).sort({ createdAt: -1 }).lean();
    } catch (error) {
      console.error("Error fetching demo requests:", error);
      throw error;
    }
  }

  static async getDemoRequestById(model, id) {
    try {
      return await model.findById(id).lean();
    } catch (error) {
      console.error("Error fetching demo request:", error);
      throw error;
    }
  }

  static async updateDemoRequest(model, id, data) {
    try {
      return await model.findByIdAndUpdate(id, data, {
        returnDocument: "after",
        runValidators: true,
      });
    } catch (error) {
      console.error("Error updating demo request:", error);
      throw error;
    }
  }

  static async deleteDemoRequest(model, id) {
    try {
      return await model.findByIdAndDelete(id);
    } catch (error) {
      console.error("Error deleting demo request:", error);
      throw error;
    }
  }
}

export default Db;
