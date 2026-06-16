import request from "supertest";

import app from "../../src/app.js";
import Conversation from "../../src/models/conversation.js";
import Message from "../../src/models/message.js";
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

const registerCreateBusinessAndConversation = async () => {
  const registerRes = await request(app).post("/api/auth/register").send({
    userName: "demoowner",
    email: "owner@callbackiq.com",
    password: "Password123",
    businessName: "Atlanta Pro Plumbing",
  });

  const token = registerRes.body.data.token;

  await request(app)
    .post("/api/businesses")
    .set("Authorization", `Bearer ${token}`)
    .send({
      businessName: "Atlanta Pro Plumbing",
      businessType: "plumbing",
      phone: "4045551234",
    });

  const conversationRes = await request(app)
    .post("/api/conversations")
    .set("Authorization", `Bearer ${token}`)
    .send({
      customerPhone: "4045559999",
      customerName: "John Smith",
    });

  return {
    token,
    conversationId: conversationRes.body.data._id,
  };
};

describe("Message Routes", () => {
  test("POST /api/messages rejects unauthenticated request", async () => {
    const res = await request(app).post("/api/messages").send({
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
    const { token, conversationId } =
      await registerCreateBusinessAndConversation();

    const res = await request(app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({
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
    const { token, conversationId } =
      await registerCreateBusinessAndConversation();

    const res = await request(app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({
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
    const { token, conversationId } =
      await registerCreateBusinessAndConversation();

    await request(app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({
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
    const { token, conversationId } =
      await registerCreateBusinessAndConversation();

    const createRes = await request(app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({
        conversation: conversationId,
        direction: "outbound",
        from: "4045551234",
        to: "4045559999",
        body: "Hello",
      });

    const messageId = createRes.body.data._id;

    const res = await request(app)
      .get(`/api/messages/${messageId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id).toBe(messageId);
  });

  test("DELETE /api/messages/:id deletes message", async () => {
    const { token, conversationId } =
      await registerCreateBusinessAndConversation();

    const createRes = await request(app)
      .post("/api/messages")
      .set("Authorization", `Bearer ${token}`)
      .send({
        conversation: conversationId,
        direction: "outbound",
        from: "4045551234",
        to: "4045559999",
        body: "Hello",
      });

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
