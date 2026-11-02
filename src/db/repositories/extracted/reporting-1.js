/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbreporting1Methods(deps) {
  const { safeConsole, verifiedAmountExpression } = deps;
  return {
async getDashboardMetrics({
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
                      { $ifNull: [verifiedAmountExpression, 0] },
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
                      { $ifNull: [verifiedAmountExpression, 0] },
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
      safeConsole.error("Error getting dashboard metrics:", error);
      throw error;
    }
  }
  };
}
