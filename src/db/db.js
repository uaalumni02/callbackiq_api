import { formatCustomerRow } from "../helpers/model/admin.js";

const BUSINESS_SCOPE_FIELDS = [
  "_id",
  "owner",
  "businessName",
  "businessType",
  "phone",
  "phoneLookup",
  "trackingNumber",
  "forwardingPhone",
  "email",
  "website",
  "address",
  "city",
  "state",
  "zipCode",
  "timezone",
  "smsTemplate",
  "estimatedJobValue",
  "features",
  "communicationLimits",
  "voiceSettings",
  "setupProgress",
  "isActive",
  "createdAt",
  "updatedAt",
].join(" ");

const CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS = [
  "_id",
  "business",
  "lead",
  "customerPhone",
  "customerName",
  "status",
  "aiEnabled",
  "humanTakeover",
  "lastMessage",
  "lastMessageAt",
  "archivedAt",
  "archivedBy",
  "archiveSnapshot",
  "createdAt",
  "updatedAt",
  "__v",
].join(" ");

const CONVERSATION_INTELLIGENCE_LEAD_FIELDS = [
  "_id",
  "business",
  "customerName",
  "phone",
  "email",
  "serviceNeeded",
  "urgency",
  "address",
  "preferredAppointmentTime",
  "leadQualityScore",
  "estimatedValue",
  "status",
  "source",
  "summary",
  "notes",
  "createdAt",
  "updatedAt",
  "__v",
].join(" ");

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

  /*
   * Lightweight tenant lookup for authenticated request handlers.
   * Avoids hydrating a Mongoose document and populating the owner when the
   * controller only needs the business scope and core settings.
   */
  static async getBusinessScopeByOwner(model, ownerId) {
    try {
      return await model
        .findOne({ owner: ownerId })
        .select(BUSINESS_SCOPE_FIELDS)
        .lean();
    } catch (error) {
      console.error("Error fetching business scope by owner:", error);
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

  static async updateBusinessByOwner(model, ownerId, data) {
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
      console.error("Error updating business by owner:", error);
      throw error;
    }
  }

  static async deleteBusinessByOwner(model, ownerId) {
    try {
      return await model.findOneAndDelete({
        owner: ownerId,
      });
    } catch (error) {
      console.error("Error deleting business by owner:", error);
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
        .populate("business", "businessName businessType phone")
        .lean();
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

  static async updateLeadForBusiness(model, id, businessId, data) {
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
      console.error("Error updating lead for business:", error);
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

  static async deleteLeadForBusiness(model, id, businessId) {
    try {
      return await model.findOneAndDelete({
        _id: id,
        business: businessId,
      });
    } catch (error) {
      console.error("Error deleting lead for business:", error);
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
        .populate("business", "businessName phone owner")
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .populate("archivedBy", "userName email role")
        .lean();
    } catch (error) {
      console.error("Error fetching conversations:", error);
      throw error;
    }
  }
  static async getConversationById(model, id) {
    try {
      return await model
        .findById(id)
        .populate("business", "businessName phone owner")
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .populate("archivedBy", "userName email role");
    } catch (error) {
      console.error("Error fetching conversation:", error);
      throw error;
    }
  }
  static async getConversationForBusiness(model, id, businessId) {
    try {
      return await model
        .findOne({
          _id: id,
          business: businessId,
        })
        .populate("business", "businessName phone owner")
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .populate("archivedBy", "userName email role")
        .lean();
    } catch (error) {
      console.error("Error fetching conversation for business:", error);
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
        .populate("business", "businessName phone owner")
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .populate("archivedBy", "userName email role");
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
        .populate("conversation", "customerPhone customerName status")
        .lean();
    } catch (error) {
      console.error("Error fetching messages:", error);
      throw error;
    }
  }

  /*
   * AI workflows only need message content and chronology. Skipping populate
   * keeps inbound-SMS and conversation-analysis requests lightweight.
   */
  static async getMessagesForAI(model, conversationId) {
    try {
      return await model
        .find({ conversation: conversationId })
        .select(
          "_id business conversation lead direction from to body provider providerMessageId status isAiGenerated generatedBy usageCategory actorType actorId metadata createdAt updatedAt",
        )
        .sort({ createdAt: 1 });
    } catch (error) {
      console.error("Error fetching messages for AI:", error);
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
  static async getMessageForBusiness(model, id, businessId) {
    try {
      return await model
        .findOne({
          _id: id,
          business: businessId,
        })
        .populate("lead", "customerName phone serviceNeeded")
        .populate("conversation", "customerPhone customerName status")
        .lean();
    } catch (error) {
      console.error("Error fetching message for business:", error);
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

  static async deleteMessageForBusiness(model, id, businessId) {
    try {
      return await model.findOneAndDelete({
        _id: id,
        business: businessId,
      });
    } catch (error) {
      console.error("Error deleting message for business:", error);
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
        .populate("conversation", "customerPhone customerName status")
        .lean();
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
  static async getCallLogForBusiness(model, id, businessId) {
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
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .populate("conversation", "customerPhone customerName status")
        .lean();
    } catch (error) {
      console.error("Error fetching call log for business:", error);
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

  static async updateCallLogForBusiness(model, id, businessId, data) {
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
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .populate("conversation", "customerPhone customerName status");
    } catch (error) {
      console.error("Error updating call log for business:", error);
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

  static async deleteCallLogForBusiness(model, id, businessId) {
    try {
      return await model.findOneAndDelete({
        _id: id,
        business: businessId,
      });
    } catch (error) {
      console.error("Error deleting call log for business:", error);
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

  static async getBusinessByPhoneForWebhook(model, phone) {
    try {
      return await model
        .findOne({
          isActive: true,
          "trackingNumber.status": "active",
          $or: [{ phone }, { phoneLookup: phone }],
        })
        .select(BUSINESS_SCOPE_FIELDS);
    } catch (error) {
      console.error("Error fetching webhook business by phone:", error);
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
      return await model
        .findOne({
          business: businessId,
          phone,
        })
        .sort({ createdAt: -1 });
    } catch (error) {
      console.error("Error fetching lead by business and phone:", error);
      throw error;
    }
  }
  static async getConversationByBusinessAndPhone(model, businessId, phone) {
    try {
      return await model
        .findOne({
          business: businessId,
          customerPhone: phone,
        })
        .sort({ lastMessageAt: -1, createdAt: -1 });
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

      const business = await Business.findOne(businessQuery)
        .select(
          "_id businessName businessType phone estimatedJobValue features owner",
        )
        .lean();

      if (!business) {
        return null;
      }

      const scopedBusinessId = business._id;
      const missedCallStatuses = ["missed", "no_answer", "busy", "failed"];

      const [callResults, leadResults, conversationResults, messageResults] =
        await Promise.all([
          CallLog.aggregate([
            {
              $match: {
                business: scopedBusinessId,
              },
            },
            {
              $group: {
                _id: null,
                totalCalls: { $sum: 1 },
                missedCalls: {
                  $sum: {
                    $cond: [{ $in: ["$status", missedCallStatuses] }, 1, 0],
                  },
                },
                answeredCalls: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "answered"] }, 1, 0],
                  },
                },
                recoveredCalls: {
                  $sum: {
                    $cond: [{ $eq: ["$recovered", true] }, 1, 0],
                  },
                },
              },
            },
          ]),

          Lead.aggregate([
            {
              $match: {
                business: scopedBusinessId,
              },
            },
            {
              $group: {
                _id: null,
                totalLeads: { $sum: 1 },
                newLeads: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "new"] }, 1, 0],
                  },
                },
                contactedLeads: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "contacted"] }, 1, 0],
                  },
                },
                bookedLeads: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "booked"] }, 1, 0],
                  },
                },
                lostLeads: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "lost"] }, 1, 0],
                  },
                },
                spamLeads: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "spam"] }, 1, 0],
                  },
                },
                bookedRevenue: {
                  $sum: {
                    $cond: [
                      { $eq: ["$status", "booked"] },
                      { $ifNull: ["$estimatedValue", 0] },
                      0,
                    ],
                  },
                },
                recoveredRevenue: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$status", "booked"] },
                          { $in: ["$source", ["missed_call", "sms"]] },
                        ],
                      },
                      { $ifNull: ["$estimatedValue", 0] },
                      0,
                    ],
                  },
                },
              },
            },
          ]),

          Conversation.aggregate([
            {
              $match: {
                business: scopedBusinessId,
              },
            },
            {
              $group: {
                _id: null,
                activeConversations: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "open"] }, 1, 0],
                  },
                },
                closedConversations: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "closed"] }, 1, 0],
                  },
                },
                archivedConversations: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "archived"] }, 1, 0],
                  },
                },
              },
            },
          ]),

          Message.aggregate([
            {
              $match: {
                business: scopedBusinessId,
              },
            },
            {
              $group: {
                _id: null,
                totalMessages: { $sum: 1 },
                smsSent: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$direction", "outbound"] },
                          { $ne: [{ $ifNull: ["$providerMessageId", ""] }, ""] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                smsDelivered: {
                  $sum: {
                    $cond: [
                      { $and: [{ $eq: ["$direction", "outbound"] }, { $eq: ["$status", "delivered"] }] },
                      1,
                      0,
                    ],
                  },
                },
                smsFailed: {
                  $sum: {
                    $cond: [
                      { $and: [{ $eq: ["$direction", "outbound"] }, { $in: ["$status", ["failed", "undelivered"]] }] },
                      1,
                      0,
                    ],
                  },
                },
                smsSegments: {
                  $sum: {
                    $cond: [
                      { $eq: ["$direction", "outbound"] },
                      { $ifNull: ["$segmentCount", 1] },
                      0,
                    ],
                  },
                },
                smsReceived: {
                  $sum: {
                    $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0],
                  },
                },
              },
            },
          ]),
        ]);

      const callMetrics = callResults[0] || {
        totalCalls: 0,
        missedCalls: 0,
        answeredCalls: 0,
        recoveredCalls: 0,
      };

      const leadMetrics = leadResults[0] || {
        totalLeads: 0,
        newLeads: 0,
        contactedLeads: 0,
        bookedLeads: 0,
        lostLeads: 0,
        spamLeads: 0,
        bookedRevenue: 0,
        recoveredRevenue: 0,
      };

      const conversationMetrics = conversationResults[0] || {
        activeConversations: 0,
        closedConversations: 0,
        archivedConversations: 0,
      };

      const messageMetrics = messageResults[0] || {
        totalMessages: 0,
        smsSent: 0,
        smsDelivered: 0,
        smsFailed: 0,
        smsSegments: 0,
        smsReceived: 0,
      };

      const missedCallRecoveryRate =
        callMetrics.missedCalls > 0
          ? Math.round(
              (callMetrics.recoveredCalls / callMetrics.missedCalls) * 100,
            )
          : 0;

      const bookingRate =
        leadMetrics.totalLeads > 0
          ? Math.round((leadMetrics.bookedLeads / leadMetrics.totalLeads) * 100)
          : 0;

      return {
        business: {
          _id: business._id,
          businessName: business.businessName,
          businessType: business.businessType,
          phone: business.phone,
          estimatedJobValue: business.estimatedJobValue,
          features: business.features || {},
        },

        calls: {
          totalCalls: callMetrics.totalCalls,
          missedCalls: callMetrics.missedCalls,
          answeredCalls: callMetrics.answeredCalls,
          recoveredCalls: callMetrics.recoveredCalls,
          missedCallRecoveryRate,
        },

        leads: {
          totalLeads: leadMetrics.totalLeads,
          newLeads: leadMetrics.newLeads,
          contactedLeads: leadMetrics.contactedLeads,
          bookedLeads: leadMetrics.bookedLeads,
          lostLeads: leadMetrics.lostLeads,
          spamLeads: leadMetrics.spamLeads,
          bookingRate,
        },

        conversations: {
          activeConversations: conversationMetrics.activeConversations,
          closedConversations: conversationMetrics.closedConversations,
          archivedConversations: conversationMetrics.archivedConversations,
          totalConversations:
            conversationMetrics.activeConversations +
            conversationMetrics.closedConversations +
            conversationMetrics.archivedConversations,
        },

        messages: {
          smsSent: messageMetrics.smsSent,
          smsDelivered: messageMetrics.smsDelivered,
          smsFailed: messageMetrics.smsFailed,
          smsSegments: messageMetrics.smsSegments,
          smsReceived: messageMetrics.smsReceived,
          totalMessages: messageMetrics.totalMessages,
          deliveryRate:
            messageMetrics.smsSent > 0
              ? Math.round((messageMetrics.smsDelivered / messageMetrics.smsSent) * 100)
              : 0,
        },

        revenue: {
          bookedRevenue: leadMetrics.bookedRevenue,
          recoveredRevenue: leadMetrics.recoveredRevenue,
        },
      };
    } catch (error) {
      console.error("Error getting dashboard metrics:", error);
      throw error;
    }
  }
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
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .lean();
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
          readAt: null,
        })
        .sort({ createdAt: -1 })
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status")
        .lean();
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
  static async getAlertForBusiness(model, id, businessId) {
    try {
      return await model
        .findOne({
          _id: id,
          business: businessId,
        })
        .populate("business", "businessName businessType phone")
        .populate("lead", "customerName phone serviceNeeded urgency status");
    } catch (error) {
      console.error("Error fetching alert for business:", error);
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

  static async updateAlertForBusiness(model, id, businessId, data) {
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
        .populate("lead", "customerName phone serviceNeeded urgency status");
    } catch (error) {
      console.error("Error updating alert for business:", error);
      throw error;
    }
  }

  static async markAlertAsRead(model, id) {
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

  static async markAlertAsReadForBusiness(model, id, businessId) {
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
        .populate("lead", "customerName phone serviceNeeded urgency status");
    } catch (error) {
      console.error("Error marking business alert as read:", error);
      throw error;
    }
  }

  static async markAllAlertsAsRead(model, businessId, readAt = new Date()) {
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

  static async deleteAlertForBusiness(model, id, businessId) {
    try {
      return await model.findOneAndDelete({
        _id: id,
        business: businessId,
      });
    } catch (error) {
      console.error("Error deleting alert for business:", error);
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
      const missedCallStatuses = ["missed", "no_answer", "busy", "failed"];

      const [
        users,
        businesses,
        subscriptions,
        leadCounts,
        callCounts,
        conversationCounts,
        messageCounts,
      ] = await Promise.all([
        User.find({}).sort({ createdAt: -1 }).lean(),
        Business.find({}).sort({ createdAt: -1 }).lean(),
        Subscription.find({}).lean(),
        Lead.aggregate([
          {
            $group: {
              _id: "$business",
              total: { $sum: 1 },
            },
          },
        ]),
        CallLog.aggregate([
          {
            $group: {
              _id: "$business",
              total: { $sum: 1 },
              missed: {
                $sum: {
                  $cond: [{ $in: ["$status", missedCallStatuses] }, 1, 0],
                },
              },
            },
          },
        ]),
        Conversation.aggregate([
          {
            $group: {
              _id: "$business",
              total: { $sum: 1 },
            },
          },
        ]),
        Message.aggregate([
          {
            $group: {
              _id: "$business",
              total: { $sum: 1 },
            },
          },
        ]),
      ]);

      const ownerMap = new Map(users.map((user) => [String(user._id), user]));
      const subscriptionMap = new Map(
        subscriptions.map((sub) => [String(sub.business), sub]),
      );
      const leadCountMap = new Map(
        leadCounts.map((entry) => [String(entry._id), entry.total]),
      );
      const callCountMap = new Map(
        callCounts.map((entry) => [String(entry._id), entry]),
      );
      const conversationCountMap = new Map(
        conversationCounts.map((entry) => [String(entry._id), entry.total]),
      );
      const messageCountMap = new Map(
        messageCounts.map((entry) => [String(entry._id), entry.total]),
      );

      const customers = businesses.map((business) => {
        const businessKey = String(business._id);
        const callMetrics = callCountMap.get(businessKey) || {
          total: 0,
          missed: 0,
        };

        return formatCustomerRow({
          business,
          owner: ownerMap.get(String(business.owner)),
          subscription: subscriptionMap.get(businessKey),
          leadCount: leadCountMap.get(businessKey) || 0,
          callCount: callMetrics.total || 0,
          missedCallCount: callMetrics.missed || 0,
          conversationCount: conversationCountMap.get(businessKey) || 0,
          messageCount: messageCountMap.get(businessKey) || 0,
        });
      });

      const totalLeads = leadCounts.reduce(
        (sum, entry) => sum + (entry.total || 0),
        0,
      );
      const totalCalls = callCounts.reduce(
        (sum, entry) => sum + (entry.total || 0),
        0,
      );
      const missedCalls = callCounts.reduce(
        (sum, entry) => sum + (entry.missed || 0),
        0,
      );
      const totalConversations = conversationCounts.reduce(
        (sum, entry) => sum + (entry.total || 0),
        0,
      );
      const totalMessages = messageCounts.reduce(
        (sum, entry) => sum + (entry.total || 0),
        0,
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

      const missedCallStatuses = ["missed", "no_answer", "busy", "failed"];

      const [
        owner,
        subscription,
        leads,
        calls,
        conversations,
        messages,
        leadMetricResults,
        callMetricResults,
        conversationMetricResults,
        messageMetricResults,
      ] = await Promise.all([
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
          .sort({ lastMessageAt: -1, createdAt: -1 })
          .limit(100)
          .lean(),
        Message.find({ business: businessId })
          .sort({ createdAt: -1 })
          .limit(200)
          .lean(),
        Lead.aggregate([
          { $match: { business: business._id } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              booked: {
                $sum: {
                  $cond: [{ $eq: ["$status", "booked"] }, 1, 0],
                },
              },
              lost: {
                $sum: {
                  $cond: [{ $eq: ["$status", "lost"] }, 1, 0],
                },
              },
            },
          },
        ]),
        CallLog.aggregate([
          { $match: { business: business._id } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              missed: {
                $sum: {
                  $cond: [{ $in: ["$status", missedCallStatuses] }, 1, 0],
                },
              },
              answered: {
                $sum: {
                  $cond: [{ $eq: ["$status", "answered"] }, 1, 0],
                },
              },
              recovered: {
                $sum: {
                  $cond: [{ $eq: ["$recovered", true] }, 1, 0],
                },
              },
            },
          },
        ]),
        Conversation.aggregate([
          { $match: { business: business._id } },
          { $count: "total" },
        ]),
        Message.aggregate([
          { $match: { business: business._id } },
          { $count: "total" },
        ]),
      ]);

      const leadMetrics = leadMetricResults[0] || {
        total: 0,
        booked: 0,
        lost: 0,
      };
      const callMetrics = callMetricResults[0] || {
        total: 0,
        missed: 0,
        answered: 0,
        recovered: 0,
      };

      return {
        business,
        owner,
        subscription: subscription || {
          plan: "none",
          status: "none",
          aiEnabled: false,
        },
        metrics: {
          leads: leadMetrics.total,
          calls: callMetrics.total,
          missedCalls: callMetrics.missed,
          answeredCalls: callMetrics.answered,
          recoveredCalls: callMetrics.recovered,
          conversations: conversationMetricResults[0]?.total || 0,
          messages: messageMetricResults[0]?.total || 0,
          bookedLeads: leadMetrics.booked,
          lostLeads: leadMetrics.lost,
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

  // ----- Trial Redemption methods -----

  static async findTrialRedemption(model, { ownerId, emailKey, phoneKey }) {
    try {
      const conditions = [];

      if (ownerId) conditions.push({ owner: ownerId });
      if (emailKey) conditions.push({ emailKey });
      if (phoneKey) conditions.push({ phoneKey });

      if (!conditions.length) return null;

      return await model.findOne({ $or: conditions }).lean();
    } catch (error) {
      console.error("Error finding trial redemption:", error);
      throw error;
    }
  }

  static async createTrialRedemption(model, data) {
    try {
      const redemption = new model(data);
      return await redemption.save();
    } catch (error) {
      if (error?.code === 11000) {
        // Surface duplicate-key so the caller can return a clean 400.
        error.isDuplicateTrial = true;
      }

      console.error("Error creating trial redemption:", error);
      throw error;
    }
  }

  static async deleteTrialRedemptionsForBusiness(model, businessId) {
    try {
      return await model.deleteMany({ business: businessId });
    } catch (error) {
      console.error("Error deleting trial redemptions:", error);
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
  static async getConversationIntelligenceByConversation(
    ConversationIntelligence,
    conversationId,
  ) {
    return ConversationIntelligence.findOne({
      conversation: conversationId,
    })
      .populate({
        path: "conversation",
        select: CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS,
      })
      .populate({
        path: "lead",
        select: CONVERSATION_INTELLIGENCE_LEAD_FIELDS,
      })
      .lean();
  }

  static async getConversationIntelligenceForBusinessByConversation(
    ConversationIntelligence,
    conversationId,
    businessId,
  ) {
    return ConversationIntelligence.findOne({
      conversation: conversationId,
      business: businessId,
    })
      .populate({
        path: "conversation",
        select: CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS,
      })
      .populate({
        path: "lead",
        select: CONVERSATION_INTELLIGENCE_LEAD_FIELDS,
      })
      .lean();
  }
  static async getConversationIntelligenceDocument(
    ConversationIntelligence,
    conversationId,
  ) {
    return ConversationIntelligence.findOne({
      conversation: conversationId,
    });
  }

  static async getConversationIntelligenceByBusiness(
    ConversationIntelligence,
    businessId,
    filters = {},
  ) {
    const {
      status,
      minimumScore,
      urgency,
      actionCompleted,
      page = 1,
      limit = 25,
    } = filters;

    const query = {
      business: businessId,
    };

    if (status) {
      query.status = status;
    }

    if (minimumScore !== undefined) {
      query["buyingLikelihood.score"] = {
        $gte: minimumScore,
      };
    }

    if (urgency) {
      query["urgency.level"] = urgency;
    }

    if (actionCompleted !== undefined) {
      query["nextBestAction.completed"] = actionCompleted;
    }

    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      ConversationIntelligence.find(query)
        .populate({
          path: "conversation",
          select: CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS,
        })
        .populate({
          path: "lead",
          select: CONVERSATION_INTELLIGENCE_LEAD_FIELDS,
        })
        .sort({
          "urgency.score": -1,
          "buyingLikelihood.score": -1,
          "estimatedRevenue.likely": -1,
          updatedAt: -1,
        })
        .skip(skip)
        .limit(limit)
        .lean(),

      ConversationIntelligence.countDocuments(query),
    ]);

    return {
      records,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }
  static async getConversationIntelligenceOpportunities(
    ConversationIntelligence,
    businessId,
    filters = {},
  ) {
    const {
      minimumScore = 70,
      minimumRevenue = 0,
      urgency,
      actionCompleted,
      page = 1,
      limit = 25,
    } = filters;

    const query = {
      business: businessId,
      status: "completed",
      "buyingLikelihood.score": {
        $gte: minimumScore,
      },
      "estimatedRevenue.likely": {
        $gte: minimumRevenue,
      },
    };

    if (urgency?.length) {
      query["urgency.level"] = {
        $in: urgency,
      };
    }

    if (actionCompleted !== undefined) {
      query["nextBestAction.completed"] = actionCompleted;
    }

    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      ConversationIntelligence.find(query)
        .populate({
          path: "conversation",
          select: CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS,
        })
        .populate({
          path: "lead",
          select: CONVERSATION_INTELLIGENCE_LEAD_FIELDS,
        })
        .sort({
          "urgency.score": -1,
          "buyingLikelihood.score": -1,
          "appointmentProbability.score": -1,
          "estimatedRevenue.likely": -1,
        })
        .skip(skip)
        .limit(limit)
        .lean(),

      ConversationIntelligence.countDocuments(query),
    ]);

    return {
      records,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }
  static async saveConversationIntelligence(ConversationIntelligence, payload) {
    return ConversationIntelligence.findOneAndUpdate(
      {
        conversation: payload.conversation,
      },
      {
        $set: payload,
      },
      {
        returnDocument: "after",
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );
  }

  static async updateConversationIntelligence(
    ConversationIntelligence,
    conversationId,
    updates,
  ) {
    return ConversationIntelligence.findOneAndUpdate(
      {
        conversation: conversationId,
      },
      {
        $set: updates,
      },
      {
        returnDocument: "after",
        runValidators: true,
      },
    );
  }

  static async updateConversationIntelligenceForBusiness(
    ConversationIntelligence,
    conversationId,
    businessId,
    updates,
  ) {
    return ConversationIntelligence.findOneAndUpdate(
      {
        conversation: conversationId,
        business: businessId,
      },
      {
        $set: updates,
      },
      {
        returnDocument: "after",
        runValidators: true,
      },
    );
  }

  static async deleteConversationIntelligence(
    ConversationIntelligence,
    conversationId,
  ) {
    return ConversationIntelligence.findOneAndDelete({
      conversation: conversationId,
    });
  }

  static async deleteConversationIntelligenceForBusiness(
    ConversationIntelligence,
    conversationId,
    businessId,
  ) {
    return ConversationIntelligence.findOneAndDelete({
      conversation: conversationId,
      business: businessId,
    });
  }

  static async getConversationIntelligenceDashboard(
    ConversationIntelligence,
    businessId,
  ) {
    const results = await ConversationIntelligence.aggregate([
      {
        $match: {
          business: businessId,
          status: "completed",
        },
      },
      {
        $group: {
          _id: null,

          totalAnalyzed: {
            $sum: 1,
          },

          highIntentLeads: {
            $sum: {
              $cond: [
                {
                  $gte: ["$buyingLikelihood.score", 80],
                },
                1,
                0,
              ],
            },
          },

          urgentLeads: {
            $sum: {
              $cond: [
                {
                  $in: ["$urgency.level", ["high", "emergency"]],
                },
                1,
                0,
              ],
            },
          },

          estimatedPipelineValue: {
            $sum: "$estimatedRevenue.likely",
          },

          averageBuyingLikelihood: {
            $avg: "$buyingLikelihood.score",
          },

          averageAppointmentProbability: {
            $avg: "$appointmentProbability.score",
          },

          likelyAppointments: {
            $sum: {
              $cond: [
                {
                  $gte: ["$appointmentProbability.score", 70],
                },
                1,
                0,
              ],
            },
          },

          pendingActions: {
            $sum: {
              $cond: [
                {
                  $eq: ["$nextBestAction.completed", false],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    return (
      results[0] || {
        totalAnalyzed: 0,
        highIntentLeads: 0,
        urgentLeads: 0,
        estimatedPipelineValue: 0,
        averageBuyingLikelihood: 0,
        averageAppointmentProbability: 0,
        likelyAppointments: 0,
        pendingActions: 0,
      }
    );
  }
}

export default Db;
