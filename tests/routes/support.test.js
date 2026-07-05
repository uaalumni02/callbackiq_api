import request from "supertest";

import app from "../../src/app.js";
import SupportTicket from "../../src/models/supportTicket.js";
import User from "../../src/models/user.js";
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

const registerAndCreateBusiness = async ({
  userName = "demoowner",
  email = "owner@callbackiq.com",
  role = "owner",
  businessName = "Atlanta Pro Plumbing",
  businessPhone = "4045551234",
  businessType = "plumbing",
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

  return {
    token: registerRes.body.data.token,
    user: registerRes.body.data.user,
    business: registerRes.body.data.business,
    subscription: registerRes.body.data.subscription,
  };
};

const registerAdmin = async ({
  userName = "adminuser",
  email = "admin@callbackiq.com",
} = {}) => {
  const registerRes = await request(app).post("/api/auth/register").send({
    userName,
    email,
    password: "Password123",
    businessName: "CallBackIQ Admin",
    businessPhone: "4045550000",
    businessType: "plumbing",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  expect(registerRes.status).toBe(201);
  expect(registerRes.body.success).toBe(true);

  const userId = registerRes.body.data.user._id;

  await User.findByIdAndUpdate(userId, {
    role: "admin",
  });

  const loginRes = await request(app).post("/api/auth/login").send({
    login: email,
    password: "Password123",
  });

  expect(loginRes.status).toBe(200);
  expect(loginRes.body.success).toBe(true);

  return {
    token: loginRes.body.data.token,
    user: loginRes.body.data.user,
    business: registerRes.body.data.business,
  };
};

const createSupportTicket = async (token, overrides = {}) => {
  return request(app)
    .post("/api/support/tickets")
    .set("Authorization", `Bearer ${token}`)
    .send({
      subject: "Billing checkout issue",
      category: "billing",
      priority: "medium",
      message: "I tried to subscribe but checkout did not open.",
      ...overrides,
    });
};

describe("Support Routes", () => {
  test("POST /api/support/tickets rejects unauthenticated request", async () => {
    const res = await request(app).post("/api/support/tickets").send({
      subject: "Billing issue",
      category: "billing",
      priority: "medium",
      message: "I need help with billing.",
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/support/tickets creates a support ticket", async () => {
    const { token, business } = await registerAndCreateBusiness();

    const res = await createSupportTicket(token);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Support ticket created successfully.");
    expect(res.body.data.subject).toBe("Billing checkout issue");
    expect(res.body.data.category).toBe("billing");
    expect(res.body.data.priority).toBe("medium");
    expect(res.body.data.status).toBe("open");
    expect(String(res.body.data.business)).toBe(String(business._id));

    const ticket = await SupportTicket.findOne({
      business: business._id,
    });

    expect(ticket).toBeTruthy();
    expect(ticket.subject).toBe("Billing checkout issue");
    expect(ticket.category).toBe("billing");
    expect(ticket.priority).toBe("medium");
    expect(ticket.status).toBe("open");
    expect(ticket.message).toBe(
      "I tried to subscribe but checkout did not open.",
    );
  });

  test("POST /api/support/tickets rejects missing subject", async () => {
    const { token } = await registerAndCreateBusiness();

    const res = await request(app)
      .post("/api/support/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({
        category: "billing",
        priority: "medium",
        message: "I need help with billing.",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Subject and message are required.");
  });

  test("POST /api/support/tickets rejects missing message", async () => {
    const { token } = await registerAndCreateBusiness();

    const res = await request(app)
      .post("/api/support/tickets")
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "Billing issue",
        category: "billing",
        priority: "medium",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Subject and message are required.");
  });

  test("POST /api/support/tickets rejects invalid category", async () => {
    const { token } = await registerAndCreateBusiness();

    const res = await createSupportTicket(token, {
      category: "bad_category",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid support category.");
  });

  test("POST /api/support/tickets rejects invalid priority", async () => {
    const { token } = await registerAndCreateBusiness();

    const res = await createSupportTicket(token, {
      priority: "urgent",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid support priority.");
  });

  test("GET /api/support/tickets rejects unauthenticated request", async () => {
    const res = await request(app).get("/api/support/tickets");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/support/tickets returns current business support tickets", async () => {
    const { token } = await registerAndCreateBusiness();

    await createSupportTicket(token, {
      subject: "First ticket",
      category: "billing",
      priority: "medium",
      message: "First message.",
    });

    await createSupportTicket(token, {
      subject: "Second ticket",
      category: "technical",
      priority: "high",
      message: "Second message.",
    });

    const res = await request(app)
      .get("/api/support/tickets")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].subject).toBe("Second ticket");
    expect(res.body.data[1].subject).toBe("First ticket");
  });

  test("GET /api/support/tickets only returns tickets for the current business", async () => {
    const ownerOne = await registerAndCreateBusiness({
      userName: "ownerone",
      email: "ownerone@callbackiq.com",
      businessName: "Owner One Plumbing",
      businessPhone: "4045551111",
    });

    const ownerTwo = await registerAndCreateBusiness({
      userName: "ownertwo",
      email: "ownertwo@callbackiq.com",
      businessName: "Owner Two HVAC",
      businessPhone: "4045552222",
      businessType: "hvac",
    });

    await createSupportTicket(ownerOne.token, {
      subject: "Owner one ticket",
      message: "Owner one message.",
    });

    await createSupportTicket(ownerTwo.token, {
      subject: "Owner two ticket",
      message: "Owner two message.",
    });

    const res = await request(app)
      .get("/api/support/tickets")
      .set("Authorization", `Bearer ${ownerOne.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].subject).toBe("Owner one ticket");
  });

  test("GET /api/support/tickets/:id returns one support ticket", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token, {
      subject: "Twilio webhook issue",
      category: "twilio_sms",
      priority: "high",
      message: "Twilio SMS webhook is not responding.",
    });

    const ticketId = createRes.body.data._id;

    const res = await request(app)
      .get(`/api/support/tickets/${ticketId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id).toBe(ticketId);
    expect(res.body.data.subject).toBe("Twilio webhook issue");
    expect(res.body.data.category).toBe("twilio_sms");
    expect(res.body.data.priority).toBe("high");
  });

  test("GET /api/support/tickets/:id rejects invalid ticket id", async () => {
    const { token } = await registerAndCreateBusiness();

    const res = await request(app)
      .get("/api/support/tickets/not-a-valid-id")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid ticket id.");
  });

  test("GET /api/support/tickets/:id returns 404 for another business ticket", async () => {
    const ownerOne = await registerAndCreateBusiness({
      userName: "ownerone",
      email: "ownerone@callbackiq.com",
      businessName: "Owner One Plumbing",
      businessPhone: "4045551111",
    });

    const ownerTwo = await registerAndCreateBusiness({
      userName: "ownertwo",
      email: "ownertwo@callbackiq.com",
      businessName: "Owner Two HVAC",
      businessPhone: "4045552222",
      businessType: "hvac",
    });

    const createRes = await createSupportTicket(ownerOne.token, {
      subject: "Private owner one ticket",
      message: "This should not be visible to owner two.",
    });

    const res = await request(app)
      .get(`/api/support/tickets/${createRes.body.data._id}`)
      .set("Authorization", `Bearer ${ownerTwo.token}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Support ticket not found.");
  });

  test("PATCH /api/support/tickets/:id rejects unauthenticated request", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token, {
      subject: "Needs edit",
      message: "This ticket will be edited.",
    });

    const res = await request(app)
      .patch(`/api/support/tickets/${createRes.body.data._id}`)
      .send({
        subject: "Updated subject",
        category: "technical",
        priority: "high",
        message: "Updated message.",
      });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("PATCH /api/support/tickets/:id updates current business ticket", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token, {
      subject: "Original subject",
      category: "billing",
      priority: "medium",
      message: "Original message.",
    });

    const ticketId = createRes.body.data._id;

    const res = await request(app)
      .patch(`/api/support/tickets/${ticketId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "Updated checkout issue",
        category: "technical",
        priority: "high",
        message: "Checkout opens, but Stripe returns an error.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Support ticket updated successfully.");
    expect(res.body.data._id).toBe(ticketId);
    expect(res.body.data.subject).toBe("Updated checkout issue");
    expect(res.body.data.category).toBe("technical");
    expect(res.body.data.priority).toBe("high");
    expect(res.body.data.message).toBe(
      "Checkout opens, but Stripe returns an error.",
    );
    expect(res.body.data.status).toBe("open");

    const ticket = await SupportTicket.findById(ticketId);

    expect(ticket.subject).toBe("Updated checkout issue");
    expect(ticket.category).toBe("technical");
    expect(ticket.priority).toBe("high");
    expect(ticket.message).toBe("Checkout opens, but Stripe returns an error.");
  });

  test("PATCH /api/support/tickets/:id supports partial updates", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token, {
      subject: "Original subject",
      category: "billing",
      priority: "medium",
      message: "Original message.",
    });

    const ticketId = createRes.body.data._id;

    const res = await request(app)
      .patch(`/api/support/tickets/${ticketId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        priority: "high",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.subject).toBe("Original subject");
    expect(res.body.data.category).toBe("billing");
    expect(res.body.data.priority).toBe("high");
    expect(res.body.data.message).toBe("Original message.");

    const ticket = await SupportTicket.findById(ticketId);

    expect(ticket.priority).toBe("high");
    expect(ticket.subject).toBe("Original subject");
  });

  test("PATCH /api/support/tickets/:id trims updated subject and message", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token, {
      subject: "Original subject",
      message: "Original message.",
    });

    const ticketId = createRes.body.data._id;

    const res = await request(app)
      .patch(`/api/support/tickets/${ticketId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "   Updated billing issue   ",
        message: "   Updated message with details.   ",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.subject).toBe("Updated billing issue");
    expect(res.body.data.message).toBe("Updated message with details.");
  });

  test("PATCH /api/support/tickets/:id rejects invalid ticket id", async () => {
    const { token } = await registerAndCreateBusiness();

    const res = await request(app)
      .patch("/api/support/tickets/not-a-valid-id")
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "Updated subject",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid ticket id.");
  });

  test("PATCH /api/support/tickets/:id rejects empty subject", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token);

    const res = await request(app)
      .patch(`/api/support/tickets/${createRes.body.data._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "   ",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Subject cannot be empty.");
  });

  test("PATCH /api/support/tickets/:id rejects empty message", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token);

    const res = await request(app)
      .patch(`/api/support/tickets/${createRes.body.data._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        message: "   ",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Message cannot be empty.");
  });

  test("PATCH /api/support/tickets/:id rejects invalid category", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token);

    const res = await request(app)
      .patch(`/api/support/tickets/${createRes.body.data._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        category: "bad_category",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid support category.");
  });

  test("PATCH /api/support/tickets/:id rejects invalid priority", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token);

    const res = await request(app)
      .patch(`/api/support/tickets/${createRes.body.data._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        priority: "urgent",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid support priority.");
  });

  test("PATCH /api/support/tickets/:id rejects updates with no valid fields", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token);

    const res = await request(app)
      .patch(`/api/support/tickets/${createRes.body.data._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        randomField: "ignored",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("No valid ticket updates provided.");
  });

  test("PATCH /api/support/tickets/:id returns 404 for another business ticket", async () => {
    const ownerOne = await registerAndCreateBusiness({
      userName: "ownerone",
      email: "ownerone@callbackiq.com",
      businessName: "Owner One Plumbing",
      businessPhone: "4045551111",
    });

    const ownerTwo = await registerAndCreateBusiness({
      userName: "ownertwo",
      email: "ownertwo@callbackiq.com",
      businessName: "Owner Two HVAC",
      businessPhone: "4045552222",
      businessType: "hvac",
    });

    const createRes = await createSupportTicket(ownerOne.token, {
      subject: "Owner one private ticket",
      message: "Owner two should not edit this.",
    });

    const res = await request(app)
      .patch(`/api/support/tickets/${createRes.body.data._id}`)
      .set("Authorization", `Bearer ${ownerTwo.token}`)
      .send({
        subject: "Attempted unauthorized update",
      });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Support ticket not found.");

    const ticket = await SupportTicket.findById(createRes.body.data._id);

    expect(ticket.subject).toBe("Owner one private ticket");
  });

  test("PATCH /api/support/tickets/:id rejects editing closed ticket", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token, {
      subject: "Closed ticket",
      message: "This ticket will be closed.",
    });

    const ticketId = createRes.body.data._id;

    await SupportTicket.findByIdAndUpdate(ticketId, {
      status: "closed",
      resolvedAt: new Date(),
    });

    const res = await request(app)
      .patch(`/api/support/tickets/${ticketId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "Should not update",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Closed or resolved tickets cannot be edited.");

    const ticket = await SupportTicket.findById(ticketId);

    expect(ticket.subject).toBe("Closed ticket");
  });

  test("PATCH /api/support/tickets/:id rejects editing resolved ticket", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token, {
      subject: "Resolved ticket",
      message: "This ticket will be resolved.",
    });

    const ticketId = createRes.body.data._id;

    await SupportTicket.findByIdAndUpdate(ticketId, {
      status: "resolved",
      resolvedAt: new Date(),
    });

    const res = await request(app)
      .patch(`/api/support/tickets/${ticketId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        message: "Should not update.",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Closed or resolved tickets cannot be edited.");

    const ticket = await SupportTicket.findById(ticketId);

    expect(ticket.message).toBe("This ticket will be resolved.");
  });

  test("PATCH /api/support/tickets/:id/close closes current business ticket", async () => {
    const { token } = await registerAndCreateBusiness();

    const createRes = await createSupportTicket(token, {
      subject: "Close me",
      message: "This ticket should be closed.",
    });

    const ticketId = createRes.body.data._id;

    const res = await request(app)
      .patch(`/api/support/tickets/${ticketId}/close`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Support ticket closed.");
    expect(res.body.data.status).toBe("closed");
    expect(res.body.data.resolvedAt).toBeTruthy();

    const ticket = await SupportTicket.findById(ticketId);

    expect(ticket.status).toBe("closed");
    expect(ticket.resolvedAt).toBeTruthy();
  });

  test("PATCH /api/support/tickets/:id/close rejects invalid ticket id", async () => {
    const { token } = await registerAndCreateBusiness();

    const res = await request(app)
      .patch("/api/support/tickets/not-a-valid-id/close")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid ticket id.");
  });

  test("PATCH /api/support/tickets/:id/close returns 404 for another business ticket", async () => {
    const ownerOne = await registerAndCreateBusiness({
      userName: "ownerone",
      email: "ownerone@callbackiq.com",
      businessName: "Owner One Plumbing",
      businessPhone: "4045551111",
    });

    const ownerTwo = await registerAndCreateBusiness({
      userName: "ownertwo",
      email: "ownertwo@callbackiq.com",
      businessName: "Owner Two HVAC",
      businessPhone: "4045552222",
      businessType: "hvac",
    });

    const createRes = await createSupportTicket(ownerOne.token, {
      subject: "Owner one private ticket",
      message: "Owner two should not close this.",
    });

    const res = await request(app)
      .patch(`/api/support/tickets/${createRes.body.data._id}/close`)
      .set("Authorization", `Bearer ${ownerTwo.token}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Support ticket not found.");
  });

  test("GET /api/admin/support/tickets returns all tickets for admin", async () => {
    const owner = await registerAndCreateBusiness();
    const admin = await registerAdmin();

    await createSupportTicket(owner.token, {
      subject: "Admin visible ticket",
      category: "technical",
      priority: "high",
      message: "Admin should be able to see this ticket.",
    });

    const res = await request(app)
      .get("/api/admin/support/tickets")
      .set("Authorization", `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].subject).toBe("Admin visible ticket");
    expect(res.body.data[0].business.businessName).toBe(
      owner.business.businessName,
    );
    expect(res.body.data[0].user.email).toBe("owner@callbackiq.com");
  });

  test("GET /api/admin/support/tickets filters by status, category, and priority", async () => {
    const owner = await registerAndCreateBusiness();
    const admin = await registerAdmin();

    await createSupportTicket(owner.token, {
      subject: "Billing medium open",
      category: "billing",
      priority: "medium",
      message: "Billing message.",
    });

    const secondTicketRes = await createSupportTicket(owner.token, {
      subject: "Technical high ticket",
      category: "technical",
      priority: "high",
      message: "Technical message.",
    });

    await SupportTicket.findByIdAndUpdate(secondTicketRes.body.data._id, {
      status: "in_progress",
    });

    const res = await request(app)
      .get(
        "/api/admin/support/tickets?status=in_progress&category=technical&priority=high",
      )
      .set("Authorization", `Bearer ${admin.token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].subject).toBe("Technical high ticket");
    expect(res.body.data[0].status).toBe("in_progress");
    expect(res.body.data[0].category).toBe("technical");
    expect(res.body.data[0].priority).toBe("high");
  });

  test("PATCH /api/admin/support/tickets/:id updates ticket status, priority, and admin notes", async () => {
    const owner = await registerAndCreateBusiness();
    const admin = await registerAdmin();

    const createRes = await createSupportTicket(owner.token, {
      subject: "Needs admin update",
      category: "billing",
      priority: "medium",
      message: "Please review this ticket.",
    });

    const ticketId = createRes.body.data._id;

    const res = await request(app)
      .patch(`/api/admin/support/tickets/${ticketId}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        status: "in_progress",
        priority: "high",
        adminNotes: "Reviewing billing setup.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe("Support ticket updated.");
    expect(res.body.data.status).toBe("in_progress");
    expect(res.body.data.priority).toBe("high");
    expect(res.body.data.adminNotes).toBe("Reviewing billing setup.");

    const ticket = await SupportTicket.findById(ticketId);

    expect(ticket.status).toBe("in_progress");
    expect(ticket.priority).toBe("high");
    expect(ticket.adminNotes).toBe("Reviewing billing setup.");
  });

  test("PATCH /api/admin/support/tickets/:id sets resolvedAt when resolved", async () => {
    const owner = await registerAndCreateBusiness();
    const admin = await registerAdmin();

    const createRes = await createSupportTicket(owner.token, {
      subject: "Resolve me",
      message: "This should be resolved by admin.",
    });

    const ticketId = createRes.body.data._id;

    const res = await request(app)
      .patch(`/api/admin/support/tickets/${ticketId}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        status: "resolved",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("resolved");
    expect(res.body.data.resolvedAt).toBeTruthy();

    const ticket = await SupportTicket.findById(ticketId);

    expect(ticket.resolvedAt).toBeTruthy();
  });

  test("PATCH /api/admin/support/tickets/:id rejects invalid status", async () => {
    const owner = await registerAndCreateBusiness();
    const admin = await registerAdmin();

    const createRes = await createSupportTicket(owner.token);

    const res = await request(app)
      .patch(`/api/admin/support/tickets/${createRes.body.data._id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        status: "bad_status",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid ticket status.");
  });

  test("PATCH /api/admin/support/tickets/:id rejects invalid priority", async () => {
    const owner = await registerAndCreateBusiness();
    const admin = await registerAdmin();

    const createRes = await createSupportTicket(owner.token);

    const res = await request(app)
      .patch(`/api/admin/support/tickets/${createRes.body.data._id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        priority: "urgent",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid ticket priority.");
  });

  test("PATCH /api/admin/support/tickets/:id rejects invalid ticket id", async () => {
    const admin = await registerAdmin();

    const res = await request(app)
      .patch("/api/admin/support/tickets/not-a-valid-id")
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        status: "resolved",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Invalid ticket id.");
  });
});