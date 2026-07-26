import request from "supertest";

import app from "../../src/app.js";

import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";
import Lead from "../../src/models/lead.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";
import Subscription from "../../src/models/subscription.js";
import ConversationIntelligence from "../../src/models/conversationIntelligence.js";

import ConversationIntelligenceService from "../../src/services/conversationIntelligence.service.js";
import SocketService from "../../src/services/socket.service.js";

import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

jest.mock("../../src/services/conversationIntelligence.service.js", () => ({
  __esModule: true,
  default: {
    analyze: jest.fn(),
  },
}));

jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitToBusiness: jest.fn(),
    emitDashboardRefresh: jest.fn(),
  },
}));

jest.setTimeout(30000);

beforeAll(async () => {
  await connectTestDB();
});

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

let testAccountNumber = 0;

const buildTestBusinessPhone = (sequence) => {
  return `404555${String(sequence).padStart(4, "0")}`;
};

const createActiveSubscription = async (businessId) => {
  return Subscription.findOneAndUpdate(
    {
      business: businessId,
    },
    {
      $set: {
        stripeCustomerId: `cus_test_intelligence_${businessId}`,
        stripeSubscriptionId: `sub_test_intelligence_${businessId}`,
        plan: "pro",
        status: "active",
        aiEnabled: true,
        isActive: true,
        cancelAtPeriodEnd: false,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        lastPaymentStatus: "paid",
      },
    },
    {
      upsert: true,
      returnDocument: "after",
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );
};

const registerAndCreateBusiness = async ({
  userName,
  email,
  businessName = "Atlanta Pro Plumbing",
  businessPhone,
  role = "owner",
} = {}) => {
  testAccountNumber += 1;

  const uniqueUserName = userName || `intelligenceowner${testAccountNumber}`;

  const uniqueEmail =
    email || `intelligence-owner-${testAccountNumber}@callbackiq.com`;

  const resolvedBusinessPhone =
    businessPhone || buildTestBusinessPhone(testAccountNumber);

  const registerRes = await request(app).post("/api/auth/register").send({
    userName: uniqueUserName,
    email: uniqueEmail,
    password: "Password123",
    role,
    businessName,
    businessPhone: resolvedBusinessPhone,
    businessType: "plumbing",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  expect(registerRes.status).toBe(201);
  expect(registerRes.body.success).toBe(true);
  expect(registerRes.body.data).toBeDefined();

  const token = registerRes.body.data.token;

  const user = await User.findOne({
    email: uniqueEmail.toLowerCase(),
  });

  expect(user).not.toBeNull();

  /*
   * Registration normally creates the business. Retain the fallback so this
   * test remains compatible with registration-flow changes.
   */
  let business = await Business.findOne({
    owner: user._id,
  });

  if (!business) {
    const businessRes = await request(app)
      .post("/api/businesses")
      .set("Authorization", `Bearer ${token}`)
      .send({
        businessName,
        businessType: "plumbing",
        phone: resolvedBusinessPhone,
        forwardingPhone: "4045550199",
        email: uniqueEmail,
        timezone: "America/New_York",
        estimatedJobValue: 800,
        isActive: true,
      });

    expect(businessRes.status).toBe(201);
    expect(businessRes.body.success).toBe(true);

    business = await Business.findById(businessRes.body.data._id);
  } else {
    business = await Business.findByIdAndUpdate(
      business._id,
      {
        $set: {
          businessName,
          businessType: "plumbing",
          phone: business.phone || resolvedBusinessPhone,
          forwardingPhone: business.forwardingPhone || "4045550199",
          email: business.email || uniqueEmail,
          timezone: business.timezone || "America/New_York",
          estimatedJobValue: 800,
          isActive: true,
        },
      },
      {
        returnDocument: "after",
        runValidators: true,
      },
    );
  }

  await createActiveSubscription(business._id);

  return {
    token,
    user,
    business,
  };
};
const createConversationFixture = async (
  business,
  {
    customerName = "Michael Johnson",
    customerPhone = "4045551001",
    serviceNeeded = "Water heater replacement",
    urgency = "high",
    estimatedValue = 2800,
    leadStatus = "new",
    conversationStatus = "open",
    createMessages = true,
  } = {},
) => {
  const lead = await Lead.create({
    business: business._id,
    customerName,
    phone: customerPhone,
    serviceNeeded,
    urgency,
    estimatedValue,
    status: leadStatus,
    source: "missed_call",
    summary: "",
  });

  const conversation = await Conversation.create({
    business: business._id,
    lead: lead._id,
    customerPhone,
    customerName,
    status: conversationStatus,
    aiEnabled: true,
    humanTakeover: false,
    lastMessage: "My water heater is leaking and I need help today.",
    lastMessageAt: new Date(),
  });

  const messages = [];

  if (createMessages) {
    messages.push(
      await Message.create({
        business: business._id,
        conversation: conversation._id,
        lead: lead._id,
        direction: "outbound",
        from: business.phone || "4045551234",
        to: customerPhone,
        body: "Sorry we missed your call. How can we help?",
        provider: "twilio",
        status: "sent",
      }),
    );

    messages.push(
      await Message.create({
        business: business._id,
        conversation: conversation._id,
        lead: lead._id,
        direction: "inbound",
        from: customerPhone,
        to: business.phone || "4045551234",
        body: "My water heater is leaking. I need a replacement today.",
        provider: "twilio",
        status: "received",
      }),
    );

    messages.push(
      await Message.create({
        business: business._id,
        conversation: conversation._id,
        lead: lead._id,
        direction: "inbound",
        from: customerPhone,
        to: business.phone || "4045551234",
        body: "I am comparing prices, but I can schedule this afternoon.",
        provider: "twilio",
        status: "received",
      }),
    );
  }

  return {
    lead,
    conversation,
    messages,
  };
};

const validAnalysisResult = {
  summary:
    "Customer needs an urgent water heater replacement and is comparing prices before scheduling.",

  customerIntent: {
    primary: "Replace leaking water heater",
    category: "replacement",
    serviceType: "Water heater replacement",
  },

  sentiment: {
    label: "urgent",
    score: -0.2,
    explanation:
      "The customer is concerned about an active leak but remains cooperative.",
  },

  buyingLikelihood: {
    score: 94,
    level: "very_high",
    reasons: [
      "Customer requested same-day service",
      "Customer provided scheduling availability",
      "Customer is actively comparing replacement options",
    ],
  },

  appointmentProbability: {
    score: 87,
    reasons: [
      "Customer said they can schedule this afternoon",
      "Customer requested service today",
    ],
  },

  urgency: {
    level: "emergency",
    score: 96,
    reason:
      "The water heater is actively leaking and may cause property damage.",
  },

  estimatedRevenue: {
    minimum: 2200,
    maximum: 3500,
    likely: 2800,
    currency: "USD",
    confidence: 80,
    basis: "Typical replacement value for a residential water heater.",
  },

  nextBestAction: {
    action:
      "Call the customer within 15 minutes and provide a same-day replacement estimate.",
    actionType: "call_now",
    priority: "critical",
    recommendedWithinMinutes: 15,
    suggestedMessage:
      "We can help with your leaking water heater. A team member will call shortly to discuss same-day replacement options.",
    completed: false,
    completedAt: null,
    outcome: "",
  },

  objections: [
    {
      category: "price",
      description: "Customer is comparing replacement prices.",
    },
  ],

  missingInformation: ["Water heater fuel type", "Tank capacity"],

  riskFlags: [
    {
      type: "safety_hazard",
      severity: "high",
      explanation: "The active leak may cause water damage.",
    },
  ],

  overallConfidence: 90,
  analysisVersion: "1.0",
  modelUsed: "test-conversation-intelligence-model",
};

const createIntelligenceRecord = async ({
  business,
  conversation,
  lead,
  status = "completed",
  buyingScore = 85,
  appointmentScore = 80,
  urgencyLevel = "high",
  urgencyScore = 85,
  estimatedRevenue = 2500,
  actionCompleted = false,
  summary = "AI-generated conversation summary.",
} = {}) => {
  return ConversationIntelligence.create({
    business: business._id,
    conversation: conversation._id,
    lead: lead?._id || null,
    status,
    summary,

    customerIntent: {
      primary: "Repair plumbing system",
      category: "repair",
      serviceType: "Plumbing repair",
    },

    sentiment: {
      label: "concerned",
      score: -0.1,
      explanation: "Customer is concerned about the service issue.",
    },

    buyingLikelihood: {
      score: buyingScore,
      level:
        buyingScore >= 90
          ? "very_high"
          : buyingScore >= 75
            ? "high"
            : buyingScore >= 50
              ? "medium"
              : buyingScore >= 25
                ? "low"
                : "very_low",
      reasons: ["Customer requested service"],
    },

    appointmentProbability: {
      score: appointmentScore,
      reasons: ["Customer discussed availability"],
    },

    urgency: {
      level: urgencyLevel,
      score: urgencyScore,
      reason: "Customer requested prompt service.",
    },

    estimatedRevenue: {
      minimum: Math.max(0, estimatedRevenue - 500),
      maximum: estimatedRevenue + 500,
      likely: estimatedRevenue,
      currency: "USD",
      confidence: 80,
      basis: "Business service value.",
    },

    nextBestAction: {
      action: "Call the customer.",
      actionType: "call_soon",
      priority:
        urgencyLevel === "emergency"
          ? "critical"
          : urgencyLevel === "high"
            ? "high"
            : "medium",
      recommendedWithinMinutes: 30,
      suggestedMessage: "A team member will contact you shortly.",
      completed: actionCompleted,
      completedAt: actionCompleted ? new Date() : null,
      outcome: actionCompleted ? "Customer contacted." : "",
    },

    objections: [],
    missingInformation: [],
    riskFlags: [],
    overallConfidence: 85,
    sourceMessageCount: 3,
    lastMessageAnalyzedAt: new Date(),
    analysisVersion: "1.0",
    modelUsed: "test-model",
    errorMessage: "",
  });
};

describe("Conversation Intelligence Routes", () => {
  describe("POST /api/conversation-intelligence/:conversationId/analyze", () => {
    test("rejects an unauthenticated request", async () => {
      const conversationId = "64b8f891f3db776c4f731234";

      const res = await request(app)
        .post(`/api/conversation-intelligence/${conversationId}/analyze`)
        .send({
          force: false,
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);

      expect(ConversationIntelligenceService.analyze).not.toHaveBeenCalled();

      expect(SocketService.emitToBusiness).not.toHaveBeenCalled();

      expect(SocketService.emitDashboardRefresh).not.toHaveBeenCalled();
    });

    test("rejects an invalid conversation ID", async () => {
      const { token } = await registerAndCreateBusiness();

      const res = await request(app)
        .post("/api/conversation-intelligence/not-a-valid-id/analyze")
        .set("Authorization", `Bearer ${token}`)
        .send({
          force: false,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);

      expect(ConversationIntelligenceService.analyze).not.toHaveBeenCalled();
    });

    test("returns an error when the conversation does not exist", async () => {
      const { token } = await registerAndCreateBusiness();

      const conversationId = "64b8f891f3db776c4f731234";

      const res = await request(app)
        .post(`/api/conversation-intelligence/${conversationId}/analyze`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          force: false,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);

      expect(ConversationIntelligenceService.analyze).not.toHaveBeenCalled();
    });

    test("prevents a user from analyzing another business's conversation", async () => {
      const firstAccount = await registerAndCreateBusiness({
        businessName: "First Plumbing Company",
      });

      const secondAccount = await registerAndCreateBusiness({
        businessName: "Second Plumbing Company",
      });

      const { conversation } = await createConversationFixture(
        secondAccount.business,
      );

      const res = await request(app)
        .post(`/api/conversation-intelligence/${conversation._id}/analyze`)
        .set("Authorization", `Bearer ${firstAccount.token}`)
        .send({
          force: false,
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);

      expect(ConversationIntelligenceService.analyze).not.toHaveBeenCalled();

      expect(await ConversationIntelligence.countDocuments()).toBe(0);
    });

    test("rejects analysis when the conversation has no messages", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { conversation } = await createConversationFixture(business, {
        createMessages: false,
      });

      const res = await request(app)
        .post(`/api/conversation-intelligence/${conversation._id}/analyze`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          force: false,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);

      expect(ConversationIntelligenceService.analyze).not.toHaveBeenCalled();

      expect(await ConversationIntelligence.countDocuments()).toBe(0);
    });

    test("analyzes a conversation, saves intelligence, updates the lead, and emits events", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { lead, conversation, messages } =
        await createConversationFixture(business);

      ConversationIntelligenceService.analyze.mockResolvedValue(
        validAnalysisResult,
      );

      const res = await request(app)
        .post(`/api/conversation-intelligence/${conversation._id}/analyze`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          force: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Conversation analyzed successfully");

      expect(res.body.data).toEqual(
        expect.objectContaining({
          status: "completed",
          summary: validAnalysisResult.summary,
          overallConfidence: 90,
          sourceMessageCount: messages.length,
        }),
      );

      expect(res.body.data.customerIntent).toEqual(
        expect.objectContaining({
          category: "replacement",
          serviceType: "Water heater replacement",
        }),
      );

      expect(res.body.data.buyingLikelihood.score).toBe(94);

      expect(res.body.data.appointmentProbability.score).toBe(87);

      expect(res.body.data.urgency.level).toBe("emergency");

      expect(res.body.data.estimatedRevenue.likely).toBe(2800);

      expect(res.body.data.nextBestAction.actionType).toBe("call_now");

      const savedIntelligence = await ConversationIntelligence.findOne({
        conversation: conversation._id,
      });

      expect(savedIntelligence).not.toBeNull();

      expect(savedIntelligence.business.toString()).toBe(
        business._id.toString(),
      );

      expect(savedIntelligence.lead.toString()).toBe(lead._id.toString());

      expect(savedIntelligence.status).toBe("completed");

      expect(savedIntelligence.buyingLikelihood.score).toBe(94);

      expect(savedIntelligence.estimatedRevenue.likely).toBe(2800);

      expect(savedIntelligence.sourceMessageCount).toBe(messages.length);

      const updatedLead = await Lead.findById(lead._id);

      expect(updatedLead).not.toBeNull();

      expect(updatedLead.leadQualityScore).toBe(94);

      expect(updatedLead.estimatedValue).toBe(2800);

      expect(updatedLead.urgency).toBe("emergency");

      expect(updatedLead.summary).toBe(validAnalysisResult.summary);

      expect(ConversationIntelligenceService.analyze).toHaveBeenCalledTimes(1);

      expect(ConversationIntelligenceService.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          business: expect.objectContaining({
            _id: business._id,
          }),
          conversation: expect.objectContaining({
            _id: conversation._id,
          }),
          lead: expect.objectContaining({
            _id: lead._id,
          }),
          messages: expect.any(Array),
        }),
      );

      expect(SocketService.emitToBusiness).toHaveBeenCalledWith(
        business._id,
        "conversation-intelligence:updated",
        expect.objectContaining({
          status: "completed",
          summary: validAnalysisResult.summary,
        }),
      );

      expect(SocketService.emitDashboardRefresh).toHaveBeenCalledWith(
        business._id,
        "conversation_intelligence_updated",
      );
    });

    test("updates an existing intelligence record when the conversation is reanalyzed", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { lead, conversation } = await createConversationFixture(business);

      await createIntelligenceRecord({
        business,
        conversation,
        lead,
        buyingScore: 60,
        appointmentScore: 55,
        estimatedRevenue: 1200,
        summary: "Original summary.",
      });

      ConversationIntelligenceService.analyze.mockResolvedValue(
        validAnalysisResult,
      );

      const res = await request(app)
        .post(`/api/conversation-intelligence/${conversation._id}/analyze`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          force: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(
        await ConversationIntelligence.countDocuments({
          conversation: conversation._id,
        }),
      ).toBe(1);

      const updated = await ConversationIntelligence.findOne({
        conversation: conversation._id,
      });

      expect(updated.summary).toBe(validAnalysisResult.summary);

      expect(updated.buyingLikelihood.score).toBe(94);

      expect(updated.estimatedRevenue.likely).toBe(2800);
    });

    test("rejects duplicate analysis while a record is processing unless force is true", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { lead, conversation } = await createConversationFixture(business);

      await createIntelligenceRecord({
        business,
        conversation,
        lead,
        status: "processing",
      });

      const res = await request(app)
        .post(`/api/conversation-intelligence/${conversation._id}/analyze`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          force: false,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);

      expect(ConversationIntelligenceService.analyze).not.toHaveBeenCalled();
    });

    test("marks the intelligence record as failed when AI analysis throws", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { conversation } = await createConversationFixture(business);

      ConversationIntelligenceService.analyze.mockRejectedValue(
        new Error("AI provider temporarily unavailable"),
      );

      const res = await request(app)
        .post(`/api/conversation-intelligence/${conversation._id}/analyze`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          force: false,
        });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);

      const failedRecord = await ConversationIntelligence.findOne({
        conversation: conversation._id,
      });

      expect(failedRecord).not.toBeNull();
      expect(failedRecord.status).toBe("failed");

      expect(failedRecord.errorMessage).toBe("Unable to analyze conversation");

      expect(SocketService.emitToBusiness).not.toHaveBeenCalledWith(
        business._id,
        "conversation-intelligence:updated",
        expect.anything(),
      );

      expect(SocketService.emitDashboardRefresh).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/conversation-intelligence", () => {
    test("rejects an unauthenticated request", async () => {
      const res = await request(app).get("/api/conversation-intelligence");

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    test("returns only intelligence records belonging to the authenticated business", async () => {
      const firstAccount = await registerAndCreateBusiness();

      const secondAccount = await registerAndCreateBusiness();

      const firstFixture = await createConversationFixture(
        firstAccount.business,
        {
          customerPhone: "4045551001",
        },
      );

      const secondFixture = await createConversationFixture(
        secondAccount.business,
        {
          customerPhone: "4045552001",
        },
      );

      await createIntelligenceRecord({
        business: firstAccount.business,
        conversation: firstFixture.conversation,
        lead: firstFixture.lead,
        summary: "First business record.",
      });

      await createIntelligenceRecord({
        business: secondAccount.business,
        conversation: secondFixture.conversation,
        lead: secondFixture.lead,
        summary: "Second business record.",
      });

      const res = await request(app)
        .get("/api/conversation-intelligence")
        .set("Authorization", `Bearer ${firstAccount.token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.records).toHaveLength(1);

      expect(res.body.data.records[0].summary).toBe("First business record.");

      expect(res.body.data.pagination.total).toBe(1);
    });

    test("filters intelligence by status, urgency, score, and action completion", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const firstFixture = await createConversationFixture(business, {
        customerPhone: "4045553001",
      });

      const secondFixture = await createConversationFixture(business, {
        customerPhone: "4045553002",
      });

      const thirdFixture = await createConversationFixture(business, {
        customerPhone: "4045553003",
      });

      await createIntelligenceRecord({
        business,
        conversation: firstFixture.conversation,
        lead: firstFixture.lead,
        status: "completed",
        buyingScore: 95,
        urgencyLevel: "emergency",
        urgencyScore: 100,
        actionCompleted: false,
      });

      await createIntelligenceRecord({
        business,
        conversation: secondFixture.conversation,
        lead: secondFixture.lead,
        status: "completed",
        buyingScore: 60,
        urgencyLevel: "normal",
        urgencyScore: 40,
        actionCompleted: false,
      });

      await createIntelligenceRecord({
        business,
        conversation: thirdFixture.conversation,
        lead: thirdFixture.lead,
        status: "failed",
        buyingScore: 90,
        urgencyLevel: "emergency",
        urgencyScore: 95,
        actionCompleted: false,
      });

      const res = await request(app)
        .get("/api/conversation-intelligence")
        .query({
          status: "completed",
          urgency: "emergency",
          minimumScore: 80,
          actionCompleted: false,
        })
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.records).toHaveLength(1);

      expect(res.body.data.records[0].buyingLikelihood.score).toBe(95);

      expect(res.body.data.records[0].urgency.level).toBe("emergency");
    });

    test("returns paginated intelligence results", async () => {
      const { token, business } = await registerAndCreateBusiness();

      for (let index = 0; index < 3; index += 1) {
        const fixture = await createConversationFixture(business, {
          customerPhone: `40455540${index}1`,
        });

        await createIntelligenceRecord({
          business,
          conversation: fixture.conversation,
          lead: fixture.lead,
          buyingScore: 70 + index,
        });
      }

      const res = await request(app)
        .get("/api/conversation-intelligence")
        .query({
          page: 1,
          limit: 2,
        })
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.records).toHaveLength(2);

      expect(res.body.data.pagination).toEqual(
        expect.objectContaining({
          page: 1,
          limit: 2,
          total: 3,
          pages: 2,
        }),
      );
    });
  });

  describe("GET /api/conversation-intelligence/opportunities", () => {
    test("returns completed opportunities matching score, revenue, and urgency filters", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const emergencyFixture = await createConversationFixture(business, {
        customerPhone: "4045555001",
      });

      const normalFixture = await createConversationFixture(business, {
        customerPhone: "4045555002",
      });

      const lowScoreFixture = await createConversationFixture(business, {
        customerPhone: "4045555003",
      });

      const failedFixture = await createConversationFixture(business, {
        customerPhone: "4045555004",
      });

      await createIntelligenceRecord({
        business,
        conversation: emergencyFixture.conversation,
        lead: emergencyFixture.lead,
        status: "completed",
        buyingScore: 95,
        urgencyLevel: "emergency",
        urgencyScore: 100,
        estimatedRevenue: 5000,
      });

      await createIntelligenceRecord({
        business,
        conversation: normalFixture.conversation,
        lead: normalFixture.lead,
        status: "completed",
        buyingScore: 90,
        urgencyLevel: "normal",
        urgencyScore: 40,
        estimatedRevenue: 6000,
      });

      await createIntelligenceRecord({
        business,
        conversation: lowScoreFixture.conversation,
        lead: lowScoreFixture.lead,
        status: "completed",
        buyingScore: 50,
        urgencyLevel: "emergency",
        urgencyScore: 95,
        estimatedRevenue: 7000,
      });

      await createIntelligenceRecord({
        business,
        conversation: failedFixture.conversation,
        lead: failedFixture.lead,
        status: "failed",
        buyingScore: 99,
        urgencyLevel: "emergency",
        urgencyScore: 100,
        estimatedRevenue: 9000,
      });

      const res = await request(app)
        .get("/api/conversation-intelligence/opportunities")
        .query({
          minimumScore: 80,
          minimumRevenue: 2500,
          urgency: "high,emergency",
        })
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.records).toHaveLength(1);

      expect(res.body.data.records[0].buyingLikelihood.score).toBe(95);

      expect(res.body.data.records[0].estimatedRevenue.likely).toBe(5000);

      expect(res.body.data.records[0].urgency.level).toBe("emergency");
    });

    test("does not return another business's opportunities", async () => {
      const firstAccount = await registerAndCreateBusiness();

      const secondAccount = await registerAndCreateBusiness();

      const secondFixture = await createConversationFixture(
        secondAccount.business,
      );

      await createIntelligenceRecord({
        business: secondAccount.business,
        conversation: secondFixture.conversation,
        lead: secondFixture.lead,
        buyingScore: 99,
        urgencyLevel: "emergency",
        estimatedRevenue: 10000,
      });

      const res = await request(app)
        .get("/api/conversation-intelligence/opportunities")
        .set("Authorization", `Bearer ${firstAccount.token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.records).toHaveLength(0);

      expect(res.body.data.pagination.total).toBe(0);
    });
  });

  describe("GET /api/conversation-intelligence/dashboard", () => {
    test("returns empty metrics for a new business", async () => {
      const { token } = await registerAndCreateBusiness();

      const res = await request(app)
        .get("/api/conversation-intelligence/dashboard")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(res.body.data).toEqual(
        expect.objectContaining({
          totalAnalyzed: 0,
          highIntentLeads: 0,
          urgentLeads: 0,
          estimatedPipelineValue: 0,
          averageBuyingLikelihood: 0,
          averageAppointmentProbability: 0,
          likelyAppointments: 0,
          pendingActions: 0,
        }),
      );
    });

    test("returns calculated intelligence dashboard metrics", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const firstFixture = await createConversationFixture(business, {
        customerPhone: "4045556001",
      });

      const secondFixture = await createConversationFixture(business, {
        customerPhone: "4045556002",
      });

      const thirdFixture = await createConversationFixture(business, {
        customerPhone: "4045556003",
      });

      await createIntelligenceRecord({
        business,
        conversation: firstFixture.conversation,
        lead: firstFixture.lead,
        status: "completed",
        buyingScore: 90,
        appointmentScore: 80,
        urgencyLevel: "emergency",
        urgencyScore: 100,
        estimatedRevenue: 3000,
        actionCompleted: false,
      });

      await createIntelligenceRecord({
        business,
        conversation: secondFixture.conversation,
        lead: secondFixture.lead,
        status: "completed",
        buyingScore: 70,
        appointmentScore: 75,
        urgencyLevel: "high",
        urgencyScore: 80,
        estimatedRevenue: 2000,
        actionCompleted: true,
      });

      await createIntelligenceRecord({
        business,
        conversation: thirdFixture.conversation,
        lead: thirdFixture.lead,
        status: "completed",
        buyingScore: 50,
        appointmentScore: 40,
        urgencyLevel: "normal",
        urgencyScore: 40,
        estimatedRevenue: 1000,
        actionCompleted: false,
      });

      const res = await request(app)
        .get("/api/conversation-intelligence/dashboard")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(res.body.data.totalAnalyzed).toBe(3);

      expect(res.body.data.highIntentLeads).toBe(1);

      expect(res.body.data.urgentLeads).toBe(2);

      expect(res.body.data.estimatedPipelineValue).toBe(6000);

      expect(res.body.data.averageBuyingLikelihood).toBe(70);

      expect(res.body.data.averageAppointmentProbability).toBe(65);

      expect(res.body.data.likelyAppointments).toBe(2);

      expect(res.body.data.pendingActions).toBe(2);
    });
  });

  describe("GET /api/conversation-intelligence/:conversationId", () => {
    test("returns intelligence for one conversation", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { lead, conversation } = await createConversationFixture(business);

      await createIntelligenceRecord({
        business,
        conversation,
        lead,
        buyingScore: 92,
        summary: "Customer is ready to schedule service.",
      });

      const res = await request(app)
        .get(`/api/conversation-intelligence/${conversation._id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Conversation intelligence fetched");

      expect(res.body.data).toEqual(
        expect.objectContaining({
          summary: "Customer is ready to schedule service.",
        }),
      );

      expect(res.body.data.buyingLikelihood.score).toBe(92);
    });

    test("prevents access to another business's intelligence", async () => {
      const firstAccount = await registerAndCreateBusiness();

      const secondAccount = await registerAndCreateBusiness();

      const secondFixture = await createConversationFixture(
        secondAccount.business,
      );

      await createIntelligenceRecord({
        business: secondAccount.business,
        conversation: secondFixture.conversation,
        lead: secondFixture.lead,
      });

      const res = await request(app)
        .get(`/api/conversation-intelligence/${secondFixture.conversation._id}`)
        .set("Authorization", `Bearer ${firstAccount.token}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    test("returns an error when intelligence does not exist", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { conversation } = await createConversationFixture(business);

      const res = await request(app)
        .get(`/api/conversation-intelligence/${conversation._id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe("PATCH /api/conversation-intelligence/:conversationId/feedback", () => {
    test("saves owner feedback and corrected values", async () => {
      const { token, user, business } = await registerAndCreateBusiness();

      const { lead, conversation } = await createConversationFixture(business);

      await createIntelligenceRecord({
        business,
        conversation,
        lead,
      });

      const res = await request(app)
        .patch(`/api/conversation-intelligence/${conversation._id}/feedback`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          rating: "partially_helpful",
          correctedIntent: "Emergency water heater replacement",
          correctedUrgency: "emergency",
          correctedEstimatedValue: 3200,
          notes: "The summary was useful, but the estimated value was too low.",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe(
        "Conversation intelligence feedback updated",
      );

      expect(res.body.data.feedback).toEqual(
        expect.objectContaining({
          rating: "partially_helpful",
          correctedIntent: "Emergency water heater replacement",
          correctedUrgency: "emergency",
          correctedEstimatedValue: 3200,
          notes: "The summary was useful, but the estimated value was too low.",
        }),
      );

      const updated = await ConversationIntelligence.findOne({
        conversation: conversation._id,
      });

      expect(updated.feedback.rating).toBe("partially_helpful");

      expect(updated.feedback.submittedBy.toString()).toBe(user._id.toString());

      expect(updated.feedback.submittedAt).toBeInstanceOf(Date);

      expect(SocketService.emitToBusiness).toHaveBeenCalledWith(
        business._id,
        "conversation-intelligence:feedback-updated",
        expect.objectContaining({
          feedback: expect.objectContaining({
            rating: "partially_helpful",
          }),
        }),
      );
    });

    test("rejects invalid feedback", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { lead, conversation } = await createConversationFixture(business);

      await createIntelligenceRecord({
        business,
        conversation,
        lead,
      });

      const res = await request(app)
        .patch(`/api/conversation-intelligence/${conversation._id}/feedback`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          rating: "excellent",
          correctedEstimatedValue: -500,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);

      expect(SocketService.emitToBusiness).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /api/conversation-intelligence/:conversationId/action", () => {
    test("marks the recommended action completed", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { lead, conversation } = await createConversationFixture(business);

      await createIntelligenceRecord({
        business,
        conversation,
        lead,
        actionCompleted: false,
      });

      const res = await request(app)
        .patch(`/api/conversation-intelligence/${conversation._id}/action`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          completed: true,
          outcome: "Customer called and appointment booked.",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Recommended action updated");

      expect(res.body.data.nextBestAction.completed).toBe(true);

      expect(res.body.data.nextBestAction.outcome).toBe(
        "Customer called and appointment booked.",
      );

      expect(res.body.data.nextBestAction.completedAt).toBeTruthy();

      const updated = await ConversationIntelligence.findOne({
        conversation: conversation._id,
      });

      expect(updated.nextBestAction.completed).toBe(true);

      expect(updated.nextBestAction.completedAt).toBeInstanceOf(Date);

      expect(SocketService.emitToBusiness).toHaveBeenCalledWith(
        business._id,
        "conversation-intelligence:action-updated",
        expect.objectContaining({
          nextBestAction: expect.objectContaining({
            completed: true,
          }),
        }),
      );

      expect(SocketService.emitDashboardRefresh).toHaveBeenCalledWith(
        business._id,
        "conversation_intelligence_action_updated",
      );
    });

    test("allows a recommended action to be reopened", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { lead, conversation } = await createConversationFixture(business);

      await createIntelligenceRecord({
        business,
        conversation,
        lead,
        actionCompleted: true,
      });

      const res = await request(app)
        .patch(`/api/conversation-intelligence/${conversation._id}/action`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          completed: false,
          outcome: "",
        });

      expect(res.status).toBe(200);

      expect(res.body.data.nextBestAction.completed).toBe(false);

      expect(res.body.data.nextBestAction.completedAt).toBeNull();
    });

    test("rejects an invalid action payload", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { lead, conversation } = await createConversationFixture(business);

      await createIntelligenceRecord({
        business,
        conversation,
        lead,
      });

      const res = await request(app)
        .patch(`/api/conversation-intelligence/${conversation._id}/action`)
        .set("Authorization", `Bearer ${token}`)
        .send({
          outcome: "Missing required completed value.",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);

      expect(SocketService.emitToBusiness).not.toHaveBeenCalled();

      expect(SocketService.emitDashboardRefresh).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /api/conversation-intelligence/:conversationId", () => {
    test("deletes conversation intelligence and emits events", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { lead, conversation } = await createConversationFixture(business);

      await createIntelligenceRecord({
        business,
        conversation,
        lead,
      });

      const res = await request(app)
        .delete(`/api/conversation-intelligence/${conversation._id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe(
        "Conversation intelligence deleted successfully",
      );

      const deleted = await ConversationIntelligence.findOne({
        conversation: conversation._id,
      });

      expect(deleted).toBeNull();

      expect(SocketService.emitToBusiness).toHaveBeenCalledWith(
        business._id,
        "conversation-intelligence:deleted",
        expect.objectContaining({
          conversationId: conversation._id.toString(),
          deletedAt: expect.any(String),
        }),
      );

      expect(SocketService.emitDashboardRefresh).toHaveBeenCalledWith(
        business._id,
        "conversation_intelligence_deleted",
      );
    });

    test("prevents deletion of another business's intelligence", async () => {
      const firstAccount = await registerAndCreateBusiness();

      const secondAccount = await registerAndCreateBusiness();

      const secondFixture = await createConversationFixture(
        secondAccount.business,
      );

      await createIntelligenceRecord({
        business: secondAccount.business,
        conversation: secondFixture.conversation,
        lead: secondFixture.lead,
      });

      const res = await request(app)
        .delete(
          `/api/conversation-intelligence/${secondFixture.conversation._id}`,
        )
        .set("Authorization", `Bearer ${firstAccount.token}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);

      expect(
        await ConversationIntelligence.countDocuments({
          conversation: secondFixture.conversation._id,
        }),
      ).toBe(1);

      expect(SocketService.emitToBusiness).not.toHaveBeenCalled();

      expect(SocketService.emitDashboardRefresh).not.toHaveBeenCalled();
    });

    test("returns an error when the intelligence record does not exist", async () => {
      const { token, business } = await registerAndCreateBusiness();

      const { conversation } = await createConversationFixture(business);

      const res = await request(app)
        .delete(`/api/conversation-intelligence/${conversation._id}`)
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);

      expect(SocketService.emitToBusiness).not.toHaveBeenCalled();

      expect(SocketService.emitDashboardRefresh).not.toHaveBeenCalled();
    });
  });
});
