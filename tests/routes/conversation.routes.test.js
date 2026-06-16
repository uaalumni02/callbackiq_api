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

const registerAndCreateBusiness = async () => {
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

  return token;
};

describe("Conversation Routes", () => {
  test("POST /api/conversations rejects unauthenticated request", async () => {
    const res = await request(app).post("/api/conversations").send({
      customerPhone: "4045551234",
      customerName: "John Smith",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/conversations creates conversation", async () => {
    const token = await registerAndCreateBusiness();

    const res = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerPhone: "4045551234",
        customerName: "John Smith",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.customerPhone).toBe("4045551234");
    expect(res.body.data.status).toBe("open");

    const savedConversation = await Conversation.findOne({
      customerPhone: "4045551234",
    });

    expect(savedConversation).toBeTruthy();
  });

  test("POST /api/conversations rejects invalid data", async () => {
    const token = await registerAndCreateBusiness();

    const res = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerPhone: "bad-phone",
        status: "pending",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/conversations returns conversations", async () => {
    const token = await registerAndCreateBusiness();

    await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerPhone: "4045551234",
        customerName: "John Smith",
      });

    const res = await request(app)
      .get("/api/conversations")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBe(1);
  });

  test("GET /api/conversations/:id returns conversation", async () => {
    const token = await registerAndCreateBusiness();

    const createRes = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerPhone: "4045551234",
        customerName: "John Smith",
      });

    const conversationId = createRes.body.data._id;

    const res = await request(app)
      .get(`/api/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id).toBe(conversationId);
  });

  test("PATCH /api/conversations/:id updates conversation", async () => {
    const token = await registerAndCreateBusiness();

    const createRes = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerPhone: "4045551234",
        customerName: "John Smith",
      });

    const conversationId = createRes.body.data._id;

    const res = await request(app)
      .patch(`/api/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerName: "John Updated",
        status: "closed",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.customerName).toBe("John Updated");
    expect(res.body.data.status).toBe("closed");
  });

  test("DELETE /api/conversations/:id deletes conversation and its messages", async () => {
    const token = await registerAndCreateBusiness();

    const createRes = await request(app)
      .post("/api/conversations")
      .set("Authorization", `Bearer ${token}`)
      .send({
        customerPhone: "4045551234",
        customerName: "John Smith",
      });

    const conversationId = createRes.body.data._id;

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
      .delete(`/api/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const deletedConversation = await Conversation.findById(conversationId);
    const messages = await Message.find({ conversation: conversationId });

    expect(deletedConversation).toBeFalsy();
    expect(messages.length).toBe(0);
  });
});
