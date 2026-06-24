import request from "supertest";

import app from "../../src/app.js";
import Business from "../../src/models/business.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";
import Subscription from "../../src/models/subscription.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
});

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const createActiveSubscription = async (businessId) => {
  await Business.findByIdAndUpdate(
    businessId,
    { isActive: true },
    { returnDocument: "after" },
  );

  return await Subscription.findOneAndUpdate(
    { business: businessId },
    {
      business: businessId,
      stripeCustomerId: "cus_test_messages",
      stripeSubscriptionId: "sub_test_messages",
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

const registerCreateBusinessAndConversation = async () => {
  const registerRes = await request(app).post("/api/auth/register").send({
    userName: "demoowner",
    email: "owner@callbackiq.com",
    password: "Password123",
    businessName: "Atlanta Pro Plumbing",
    businessPhone: "4045551234",
    businessType: "plumbing",
  });

  const token = registerRes.body.data.token;
  const businessId = registerRes.body.data.business._id;

  await createActiveSubscription(businessId);

  const conversationRes = await request(app)
    .post("/api/conversations")
    .set("Authorization", `Bearer ${token}`)
    .send({
      business: businessId,
      customerPhone: "4045559999",
      customerName: "John Smith",
    });

  expect(conversationRes.status).toBe(201);

  return {
    token,
    businessId,
    conversationId: conversationRes.body.data._id,
  };
};

describe("Message Routes", () => {
  test("POST /api/messages rejects unauthenticated request", async () => {
    const res = await request(app).post("/api/messages").send({
      business: "665000000000000000000002",
      conversation: "665000000000000000000001",
      direction: "outbound",
      from: "4045551234",
      to: "4045559999",
      body: "Hello",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/messages creates message and updates conversation lastMessage", async () => {
    const { token, businessId, conversationId } =
      await registerCreateBusinessAndConversation();

    const res = await request(app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({
        business: businessId,
        conversation: conversationId,
        direction: "outbound",
        from: "4045551234",
        to: "4045559999",
        body: "Hi, sorry we missed your call.",
        provider: "manual",
        status: "sent",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.business.toString()).toBe(businessId);
    expect(res.body.data.body).toBe("Hi, sorry we missed your call.");

    const savedMessage = await Message.findOne({
      conversation: conversationId,
    });

    const updatedConversation = await Conversation.findById(conversationId);

    expect(savedMessage).toBeTruthy();
    expect(updatedConversation.lastMessage).toBe(
      "Hi, sorry we missed your call.",
    );
    expect(updatedConversation.lastMessageAt).toBeTruthy();
  });

  test("POST /api/messages rejects invalid data", async () => {
    const { token, businessId, conversationId } =
      await registerCreateBusinessAndConversation();

    const res = await request(app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({
        business: businessId,
        conversation: conversationId,
        direction: "sideways",
        from: "bad-phone",
        to: "4045559999",
        body: "",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/messages/conversation/:conversationId returns messages", async () => {
    const { token, businessId, conversationId } =
      await registerCreateBusinessAndConversation();

    await request(app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({
        business: businessId,
        conversation: conversationId,
        direction: "outbound",
        from: "4045551234",
        to: "4045559999",
        body: "Hello",
      });

    const res = await request(app)
      .get(`/api/messages/conversation/${conversationId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].body).toBe("Hello");
  });

  test("GET /api/messages/:id returns message", async () => {
    const { token, businessId, conversationId } =
      await registerCreateBusinessAndConversation();

    const createRes = await request(app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({
        business: businessId,
        conversation: conversationId,
        direction: "outbound",
        from: "4045551234",
        to: "4045559999",
        body: "Hello",
      });

    expect(createRes.status).toBe(201);

    const messageId = createRes.body.data._id;

    const res = await request(app)
      .get(`/api/messages/${messageId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id).toBe(messageId);
  });

  test("DELETE /api/messages/:id deletes message", async () => {
    const { token, businessId, conversationId } =
      await registerCreateBusinessAndConversation();

    const createRes = await request(app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({
        business: businessId,
        conversation: conversationId,
        direction: "outbound",
        from: "4045551234",
        to: "4045559999",
        body: "Hello",
      });

    expect(createRes.status).toBe(201);

    const messageId = createRes.body.data._id;

    const res = await request(app)
      .delete(`/api/messages/${messageId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const deletedMessage = await Message.findById(messageId);

    expect(deletedMessage).toBeFalsy();
  });
});
