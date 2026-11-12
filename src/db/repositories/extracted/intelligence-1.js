import mongoose from 'mongoose';
import {tenantRepository,tenantContext} from '../tenantRepository.js';
/* Source-exact Db extraction. Preserve order and outcome contracts. */
export function createDbintelligence1Methods(deps) {
  const { CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS, CONVERSATION_INTELLIGENCE_LEAD_FIELDS } = deps;
  return {


async getConversationIntelligenceForBusinessByConversation(
    ConversationIntelligence,
    conversationId,
    businessId,
  ) {
    return tenantRepository(ConversationIntelligence,tenantContext(businessId),{identityField:'conversation'}).read(conversationId,{populate:[
      {path:'conversation',select:CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS},
      {path:'lead',select:CONVERSATION_INTELLIGENCE_LEAD_FIELDS},
    ]});
  },

async getConversationIntelligenceByBusiness(
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

    const repo=tenantRepository(ConversationIntelligence,tenantContext(businessId));
    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      repo.list(query,{populate:[
        {path:'conversation',select:CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS},
        {path:'lead',select:CONVERSATION_INTELLIGENCE_LEAD_FIELDS},
      ],sort:{
          "urgency.score": -1,
          "buyingLikelihood.score": -1,
          "estimatedRevenue.likely": -1,
          updatedAt: -1,
        },skip,limit}),
      repo.count(query),
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
  },

async getConversationIntelligenceOpportunities(
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

    const repo=tenantRepository(ConversationIntelligence,tenantContext(businessId));
    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
      repo.list(query,{populate:[
        {path:'conversation',select:CONVERSATION_INTELLIGENCE_CONVERSATION_FIELDS},
        {path:'lead',select:CONVERSATION_INTELLIGENCE_LEAD_FIELDS},
      ],sort:{
          "urgency.score": -1,
          "buyingLikelihood.score": -1,
          "appointmentProbability.score": -1,
          "estimatedRevenue.likely": -1,
        },skip,limit}),
      repo.count(query),
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
  },





async updateConversationIntelligenceForBusiness(model,conversationId,businessId,updates) {
    return tenantRepository(model,tenantContext(businessId),{identityField:'conversation'}).update(conversationId,{$set:updates});
  },

async getConversationIntelligenceDashboard(
    ConversationIntelligence,
    businessId,
  ) {
    const {businessId:validatedBusiness}=tenantContext(businessId);const results = await ConversationIntelligence.aggregate([
      {
        $match: {
          business: new mongoose.Types.ObjectId(validatedBusiness),
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
  };
}
