import request from "supertest";

import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";
import Subscription from "../../src/models/subscription.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

/* CALLBACKIQ_CONVERSATION_ROUTE_SMS_MOCK: conversation lifecycle route tests must not depend on
 * recipient-local quiet hours, Twilio credentials, or carrier availability. */
jest.mock("../../src/services/twilioSmsService.js", () => {
  let sequence = 0;

  return {
    __esModule: true,
    sendSms: jest.fn(async ({ body = "" } = {}) => ({
      sid: `SM_CONVERSATION_ROUTE_TEST_${++sequence}`,
      status: "sent",
      suppressed: false,
      body,
      encoding: "GSM-7",
      segmentCount: 1,
    })),
  };
});

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const getAuthorizationHeader = (token) => ({
  Authorization: `Bearer ${token}`,
});

const createActiveSubscription = async (businessId) => {
  const businessIdString = businessId.toString();

  await Business.findByIdAndUpdate(
    businessId,
    {
      isActive: true,
    },
    {
      returnDocument: "after",
    },
  );

  return Subscription.findOneAndUpdate(
    {
      business: businessId,
    },
    {
      business: businessId,
      stripeCustomerId: `cus_test_conversations_${businessIdString}`,
      stripeSubscriptionId: `sub_test_conversations_${businessIdString}`,
      plan: "pro",
      status: "active",
      aiEnabled: true,
      cancelAtPeriodEnd: false,
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
  userName = "demoowner",
  email = "owner@callbackiq.com",
  role = "owner",
  businessName = "Atlanta Pro Plumbing",
  businessPhone = "4045551234",
  businessType = "plumbing",
  activateSubscription = true,
} = {}) => {
  const registerRes = await request(app).post("/api/auth/register").send({
    userName,
    email,
    password: "Password123",
    role,
    businessName,
    businessPhone,
    businessType,
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  expect(registerRes.status).toBe(201);
  expect(registerRes.body.success).toBe(true);
  expect(registerRes.body.data?.token).toBeTruthy();
  expect(registerRes.body.data?.business?._id).toBeTruthy();

  const token = registerRes.body.data.token;
  const userId = registerRes.body.data.user._id;
  const businessId = registerRes.body.data.business._id;

  if (activateSubscription) {
    await createActiveSubscription(businessId);
  }

  return {
    token,
    userId,
    businessId,
    user: registerRes.body.data.user,
    business: registerRes.body.data.business,
  };
};

const createConversation = async ({
  token,
  businessId,
  customerPhone = "4045551234",
  customerName = "John Smith",
  status = "open",
  aiEnabled = true,
  humanTakeover = false,
} = {}) => {
  const res = await request(app)
    .post("/api/conversations")
    .set(getAuthorizationHeader(token))
    .send({
      business: businessId,
      customerPhone,
      customerName,
      status,
      aiEnabled,
      humanTakeover,
    });

  expect(res.status).toBe(201);
  expect(res.body.success).toBe(true);
  expect(res.body.data?._id).toBeTruthy();

  return res.body.data;
};

const createConversationMessage = async ({
  token,
  businessId,
  conversationId,
  body = "Hello",
  direction = "outbound",
  from = "4045551234",
  to = "4045559999",
} = {}) => {
  const res = await request(app)
    .post("/api/messages")
    .set(getAuthorizationHeader(token))
    .send({
      business: businessId,
      conversation: conversationId,
      direction,
      from,
      to,
      body,
    });

  expect(res.status).toBe(201);
  expect(res.body.success).toBe(true);

  return res.body.data;
};

describe("Conversation Routes", () => {
  describe("Authentication", () => {
    test("POST /api/conversations rejects unauthenticated request", async () => {
      const res = await request(app).post("/api/conversations").send({
        business: "665000000000000000000001",
        customerPhone: "4045551234",
        customerName: "John Smith",
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    test.each([
      {
        method: "post",
        path: "/api/conversations/665000000000000000000001/archive",
      },
      {
        method: "post",
        path: "/api/conversations/665000000000000000000001/restore",
      },
      {
        method: "delete",
        path: "/api/conversations/665000000000000000000001",
      },
    ])(
      "$method $path rejects unauthenticated request",
      async ({ method, path }) => {
        const res = await request(app)[method](path);

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      },
    );
  });

  describe("Create conversation", () => {
    test("POST /api/conversations creates conversation", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const res = await request(app)
        .post("/api/conversations")
        .set(getAuthorizationHeader(token))
        .send({
          business: businessId,
          customerPhone: "4045551234",
          customerName: "John Smith",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.business.toString()).toBe(businessId);
      expect(res.body.data.customerPhone).toBe("+14045551234");
      expect(res.body.data.customerName).toBe("John Smith");
      expect(res.body.data.status).toBe("open");

      expect(res.body.data.permissions).toEqual(
        expect.objectContaining({
          canArchive: true,
          canRestore: false,
          canDelete: true,
        }),
      );

      const savedConversation = await Conversation.findOne({
        customerPhone: "+14045551234",
      });

      expect(savedConversation).toBeTruthy();
      expect(savedConversation.status).toBe("open");
    });

    test("POST /api/conversations rejects invalid data", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const res = await request(app)
        .post("/api/conversations")
        .set(getAuthorizationHeader(token))
        .send({
          business: businessId,
          customerPhone: "bad-phone",
          status: "pending",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test("POST /api/conversations rejects archived as an initial status", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const res = await request(app)
        .post("/api/conversations")
        .set(getAuthorizationHeader(token))
        .send({
          business: businessId,
          customerPhone: "4045551234",
          customerName: "John Smith",
          status: "archived",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);

      const savedConversation = await Conversation.findOne({
        business: businessId,
        customerPhone: "4045551234",
      });

      expect(savedConversation).toBeFalsy();
    });
  });

  describe("Read conversations", () => {
    test("GET /api/conversations returns conversations with permissions", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      await createConversation({
        token,
        businessId,
      });

      const res = await request(app)
        .get("/api/conversations")
        .set(getAuthorizationHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);

      expect(res.body.data[0]).toEqual(
        expect.objectContaining({
          customerName: "John Smith",
          customerPhone: "+14045551234",
          status: "open",
        }),
      );

      expect(res.body.data[0].permissions).toEqual(
        expect.objectContaining({
          canArchive: true,
          canRestore: false,
          canDelete: true,
        }),
      );
    });

    test("GET /api/conversations includes archived conversations", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
      });

      const archiveRes = await request(app)
        .post(`/api/conversations/${conversation._id}/archive`)
        .set(getAuthorizationHeader(token));

      expect(archiveRes.status).toBe(200);

      const res = await request(app)
        .get("/api/conversations")
        .set(getAuthorizationHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe("archived");

      expect(res.body.data[0].permissions).toEqual(
        expect.objectContaining({
          canArchive: false,
          canRestore: true,
          canDelete: true,
        }),
      );
    });

    test("GET /api/conversations/:id returns conversation", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
      });

      const res = await request(app)
        .get(`/api/conversations/${conversation._id}`)
        .set(getAuthorizationHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data._id).toBe(conversation._id);

      expect(res.body.data.permissions).toEqual(
        expect.objectContaining({
          canArchive: true,
          canRestore: false,
          canDelete: true,
        }),
      );
    });

    test("GET /api/conversations/:id rejects access to another business conversation", async () => {
      const owner = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token: owner.token,
        businessId: owner.businessId,
      });

      const otherOwner = await registerAndCreateBusiness({
        userName: "otherowner",
        email: "otherowner@callbackiq.com",
        businessName: "Other Plumbing Company",
        businessPhone: "4045552222",
      });

      const res = await request(app)
        .get(`/api/conversations/${conversation._id}`)
        .set(getAuthorizationHeader(otherOwner.token));

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe("Update conversation", () => {
    test("PATCH /api/conversations/:id updates conversation", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
      });

      const res = await request(app)
        .patch(`/api/conversations/${conversation._id}`)
        .set(getAuthorizationHeader(token))
        .send({
          business: businessId,
          customerName: "John Updated",
          status: "closed",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.customerName).toBe("John Updated");
      expect(res.body.data.status).toBe("closed");
    });

    test("PATCH /api/conversations/:id cannot archive a conversation directly", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
      });

      const res = await request(app)
        .patch(`/api/conversations/${conversation._id}`)
        .set(getAuthorizationHeader(token))
        .send({
          status: "archived",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/archive conversation endpoint/i);

      const savedConversation = await Conversation.findById(conversation._id);

      expect(savedConversation.status).toBe("open");
      expect(savedConversation.archivedAt).toBeNull();
      expect(savedConversation.archiveSnapshot).toBeNull();
    });

    test("PATCH /api/conversations/:id cannot change archived status without restoring", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
      });

      const archiveRes = await request(app)
        .post(`/api/conversations/${conversation._id}/archive`)
        .set(getAuthorizationHeader(token));

      expect(archiveRes.status).toBe(200);

      const res = await request(app)
        .patch(`/api/conversations/${conversation._id}`)
        .set(getAuthorizationHeader(token))
        .send({
          status: "closed",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/restore the conversation/i);

      const savedConversation = await Conversation.findById(conversation._id);

      expect(savedConversation.status).toBe("archived");
    });
  });

  describe("Archive conversation", () => {
    test("POST /api/conversations/:id/archive stores previous workflow state and pauses AI", async () => {
      const { token, userId, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
        status: "open",
        aiEnabled: true,
        humanTakeover: false,
      });

      await createConversationMessage({
        token,
        businessId,
        conversationId: conversation._id,
        body: "I need help with a leaking water heater.",
        direction: "inbound",
        from: "4045559999",
        to: "4045551234",
      });

      const res = await request(app)
        .post(`/api/conversations/${conversation._id}/archive`)
        .set(getAuthorizationHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/archived successfully/i);

      expect(res.body.data.status).toBe("archived");
      expect(res.body.data.aiEnabled).toBe(false);
      expect(res.body.data.humanTakeover).toBe(true);
      expect(res.body.data.archivedAt).toBeTruthy();
      expect(res.body.data.archivedBy).toBeTruthy();

      expect(res.body.data.permissions).toEqual(
        expect.objectContaining({
          canArchive: false,
          canRestore: true,
          canDelete: true,
        }),
      );

      const savedConversation = await Conversation.findById(
        conversation._id,
      ).lean();

      expect(savedConversation.status).toBe("archived");
      expect(savedConversation.aiEnabled).toBe(false);
      expect(savedConversation.humanTakeover).toBe(true);
      expect(savedConversation.archivedAt).toBeInstanceOf(Date);
      expect(savedConversation.archivedBy.toString()).toBe(userId);

      expect(savedConversation.archiveSnapshot).toEqual(
        expect.objectContaining({
          status: "open",
          aiEnabled: false,
          humanTakeover: true,
        }),
      );

      const messages = await Message.find({
        conversation: conversation._id,
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe("I need help with a leaking water heater.");
    });

    test("POST /api/conversations/:id/archive preserves a closed manual-takeover state", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
        status: "closed",
        aiEnabled: false,
        humanTakeover: true,
      });

      const res = await request(app)
        .post(`/api/conversations/${conversation._id}/archive`)
        .set(getAuthorizationHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("archived");

      const savedConversation = await Conversation.findById(
        conversation._id,
      ).lean();

      expect(savedConversation.archiveSnapshot).toEqual(
        expect.objectContaining({
          status: "closed",
          aiEnabled: false,
          humanTakeover: true,
        }),
      );
    });

    test("POST /api/conversations/:id/archive is idempotent for an already archived conversation", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
      });

      const firstArchiveRes = await request(app)
        .post(`/api/conversations/${conversation._id}/archive`)
        .set(getAuthorizationHeader(token));

      expect(firstArchiveRes.status).toBe(200);

      const firstArchivedAt = firstArchiveRes.body.data.archivedAt;

      const secondArchiveRes = await request(app)
        .post(`/api/conversations/${conversation._id}/archive`)
        .set(getAuthorizationHeader(token));

      expect(secondArchiveRes.status).toBe(200);
      expect(secondArchiveRes.body.success).toBe(true);
      expect(secondArchiveRes.body.message).toMatch(/already archived/i);
      expect(secondArchiveRes.body.data.status).toBe("archived");
      expect(secondArchiveRes.body.data.archivedAt).toBe(firstArchivedAt);
    });

    test("POST /api/conversations/:id/archive rejects another business owner", async () => {
      const owner = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token: owner.token,
        businessId: owner.businessId,
      });

      const otherOwner = await registerAndCreateBusiness({
        userName: "archiveotherowner",
        email: "archiveotherowner@callbackiq.com",
        businessName: "Archive Other Plumbing",
        businessPhone: "4045553333",
      });

      const res = await request(app)
        .post(`/api/conversations/${conversation._id}/archive`)
        .set(getAuthorizationHeader(otherOwner.token));

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);

      const savedConversation = await Conversation.findById(conversation._id);

      expect(savedConversation).toBeTruthy();
      expect(savedConversation.status).toBe("open");
    });

    test("POST /api/conversations/:id/archive rejects invalid conversation ID", async () => {
      const { token } = await registerAndCreateBusiness();

      const res = await request(app)
        .post("/api/conversations/not-a-valid-id/archive")
        .set(getAuthorizationHeader(token));

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/invalid conversation id/i);
    });
  });

  describe("Restore conversation", () => {
    test("POST /api/conversations/:id/restore restores exact previous workflow state", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
        status: "open",
        aiEnabled: true,
        humanTakeover: false,
      });

      await createConversationMessage({
        token,
        businessId,
        conversationId: conversation._id,
        body: "Can someone come this afternoon?",
        direction: "inbound",
        from: "4045559999",
        to: "4045551234",
      });

      const archiveRes = await request(app)
        .post(`/api/conversations/${conversation._id}/archive`)
        .set(getAuthorizationHeader(token));

      expect(archiveRes.status).toBe(200);
      expect(archiveRes.body.data.status).toBe("archived");

      const restoreRes = await request(app)
        .post(`/api/conversations/${conversation._id}/restore`)
        .set(getAuthorizationHeader(token));

      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.success).toBe(true);
      expect(restoreRes.body.message).toMatch(/restored successfully/i);

      expect(restoreRes.body.data.status).toBe("open");
      expect(restoreRes.body.data.aiEnabled).toBe(false);
      expect(restoreRes.body.data.humanTakeover).toBe(true);
      expect(restoreRes.body.data.archivedAt).toBeNull();
      expect(restoreRes.body.data.archivedBy).toBeNull();
      expect(restoreRes.body.data.archiveSnapshot).toBeNull();

      expect(restoreRes.body.data.permissions).toEqual(
        expect.objectContaining({
          canArchive: true,
          canRestore: false,
          canDelete: true,
        }),
      );

      const savedConversation = await Conversation.findById(
        conversation._id,
      ).lean();

      expect(savedConversation.status).toBe("open");
      expect(savedConversation.aiEnabled).toBe(false);
      expect(savedConversation.humanTakeover).toBe(true);
      expect(savedConversation.archivedAt).toBeNull();
      expect(savedConversation.archivedBy).toBeNull();
      expect(savedConversation.archiveSnapshot).toBeNull();

      const messages = await Message.find({
        conversation: conversation._id,
      });

      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe("Can someone come this afternoon?");
    });

    test("POST /api/conversations/:id/restore restores a closed manual-takeover conversation", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
        status: "closed",
        aiEnabled: false,
        humanTakeover: true,
      });

      const archiveRes = await request(app)
        .post(`/api/conversations/${conversation._id}/archive`)
        .set(getAuthorizationHeader(token));

      expect(archiveRes.status).toBe(200);

      const restoreRes = await request(app)
        .post(`/api/conversations/${conversation._id}/restore`)
        .set(getAuthorizationHeader(token));

      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.data.status).toBe("closed");
      expect(restoreRes.body.data.aiEnabled).toBe(false);
      expect(restoreRes.body.data.humanTakeover).toBe(true);
    });

    test("POST /api/conversations/:id/restore is idempotent for an active conversation", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
      });

      const res = await request(app)
        .post(`/api/conversations/${conversation._id}/restore`)
        .set(getAuthorizationHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/already active/i);
      expect(res.body.data.status).toBe("open");
      expect(res.body.data.archivedAt).toBeNull();
      expect(res.body.data.archiveSnapshot).toBeNull();
    });

    test("POST /api/conversations/:id/restore rejects another business owner", async () => {
      const owner = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token: owner.token,
        businessId: owner.businessId,
      });

      const archiveRes = await request(app)
        .post(`/api/conversations/${conversation._id}/archive`)
        .set(getAuthorizationHeader(owner.token));

      expect(archiveRes.status).toBe(200);

      const otherOwner = await registerAndCreateBusiness({
        userName: "restoreotherowner",
        email: "restoreotherowner@callbackiq.com",
        businessName: "Restore Other Plumbing",
        businessPhone: "4045554444",
      });

      const res = await request(app)
        .post(`/api/conversations/${conversation._id}/restore`)
        .set(getAuthorizationHeader(otherOwner.token));

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);

      const savedConversation = await Conversation.findById(conversation._id);

      expect(savedConversation).toBeTruthy();
      expect(savedConversation.status).toBe("archived");
    });
  });

  describe("Delete conversation", () => {
    test("DELETE /api/conversations/:id allows the business owner and deletes messages", async () => {
      const { token, businessId } = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token,
        businessId,
      });

      await createConversationMessage({
        token,
        businessId,
        conversationId: conversation._id,
        body: "First conversation message",
      });

      await createConversationMessage({
        token,
        businessId,
        conversationId: conversation._id,
        body: "Second conversation message",
      });

      const messagesBeforeDelete = await Message.find({
        conversation: conversation._id,
      });

      expect(messagesBeforeDelete).toHaveLength(2);

      const res = await request(app)
        .delete(`/api/conversations/${conversation._id}`)
        .set(getAuthorizationHeader(token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/deleted successfully/i);

      const deletedConversation = await Conversation.findById(conversation._id);

      const messagesAfterDelete = await Message.find({
        conversation: conversation._id,
      });

      expect(deletedConversation).toBeFalsy();
      expect(messagesAfterDelete).toHaveLength(0);
    });

    test("DELETE /api/conversations/:id allows an administrator to delete another business conversation", async () => {
      const owner = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token: owner.token,
        businessId: owner.businessId,
      });

      await createConversationMessage({
        token: owner.token,
        businessId: owner.businessId,
        conversationId: conversation._id,
        body: "Message that should be deleted by the administrator.",
      });

      const administrator = await registerAndCreateBusiness({
        userName: "platformadmin",
        email: "platformadmin@callbackiq.com",
        role: "admin",
        businessName: "CallBackIQ Administration",
        businessPhone: "4045555555",
      });

      // Administrators bypass the customer subscription requirement for
      // archive, restore, and delete management actions.
      await Subscription.deleteOne({
        business: administrator.businessId,
      });

      const res = await request(app)
        .delete(`/api/conversations/${conversation._id}`)
        .set(getAuthorizationHeader(administrator.token));

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/deleted successfully/i);

      const deletedConversation = await Conversation.findById(conversation._id);

      const messages = await Message.find({
        conversation: conversation._id,
      });

      expect(deletedConversation).toBeFalsy();
      expect(messages).toHaveLength(0);
    });

    test("DELETE /api/conversations/:id rejects a member from another business", async () => {
      const owner = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token: owner.token,
        businessId: owner.businessId,
      });

      await createConversationMessage({
        token: owner.token,
        businessId: owner.businessId,
        conversationId: conversation._id,
        body: "This message must remain after denied deletion.",
      });

      const member = await registerAndCreateBusiness({
        userName: "businessmember",
        email: "businessmember@callbackiq.com",
        role: "member",
        businessName: "Member Test Business",
        businessPhone: "4045556666",
      });

      const res = await request(app)
        .delete(`/api/conversations/${conversation._id}`)
        .set(getAuthorizationHeader(member.token));

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);

      const savedConversation = await Conversation.findById(conversation._id);

      const messages = await Message.find({
        conversation: conversation._id,
      });

      expect(savedConversation).toBeTruthy();
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe(
        "This message must remain after denied deletion.",
      );
    });

    test("DELETE /api/conversations/:id rejects another business owner", async () => {
      const owner = await registerAndCreateBusiness();

      const conversation = await createConversation({
        token: owner.token,
        businessId: owner.businessId,
      });

      const otherOwner = await registerAndCreateBusiness({
        userName: "deleteotherowner",
        email: "deleteotherowner@callbackiq.com",
        businessName: "Delete Other Plumbing",
        businessPhone: "4045557777",
      });

      const res = await request(app)
        .delete(`/api/conversations/${conversation._id}`)
        .set(getAuthorizationHeader(otherOwner.token));

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);

      const savedConversation = await Conversation.findById(conversation._id);

      expect(savedConversation).toBeTruthy();
    });

    test("DELETE /api/conversations/:id rejects invalid conversation ID", async () => {
      const { token } = await registerAndCreateBusiness();

      const res = await request(app)
        .delete("/api/conversations/not-a-valid-id")
        .set(getAuthorizationHeader(token));

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/invalid conversation id/i);
    });
  });
});
