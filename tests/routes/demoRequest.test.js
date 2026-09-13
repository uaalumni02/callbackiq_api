import jwt from "jsonwebtoken";
import request from "supertest";

import app from "../../src/app.js";
import DemoRequest from "../../src/models/demoRequest.js";
import User from "../../src/models/user.js";
import { connectTestDB, clearTestDB, closeTestDB } from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
}, 60_000);

afterEach(async () => {
  await clearTestDB();
});

afterAll(async () => {
  await closeTestDB();
});

const createTokenForUser = (user) =>
  jwt.sign(
    {
      userId: user._id,
      id: user._id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "1h",
    },
  );

const registerAdmin = async () => {
  const user = await User.create({
    userName: "adminuser",
    email: "admin@callbackiq.com",
    password: "Password123",
    role: "admin",
    businessName: "CallBackIQ Admin",
    businessPhone: "8882927988",
    businessType: "other",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  return {
    token: createTokenForUser(user),
    user,
  };
};

const registerOwner = async () => {
  const user = await User.create({
    userName: "demoowner",
    email: "owner@callbackiq.com",
    password: "Password123",
    role: "owner",
    businessName: "Atlanta Pro Plumbing",
    businessPhone: "4045551234",
    businessType: "plumbing",
    smsConsent: true,
    termsAccepted: true,
    privacyAccepted: true,
  });

  return {
    token: createTokenForUser(user),
    user,
  };
};

const createDemoRequestPayload = (overrides = {}) => ({
  fullName: "John Smith",
  email: "john@example.com",
  phone: "4045551111",
  businessName: "Atlanta Pro Plumbing",
  businessType: "Plumbing",
  website: "https://example.com",
  preferredTime: "Tomorrow afternoon",
  message: "I want to see how missed-call recovery works.",
  ...overrides,
});

describe("Demo Request Routes", () => {
  test("POST /api/demo-requests creates demo request without auth", async () => {
    const res = await request(app)
      .post("/api/demo-requests")
      .send(createDemoRequestPayload());

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.fullName).toBe("John Smith");
    expect(res.body.data.email).toBe("john@example.com");
    expect(res.body.data.businessName).toBe("Atlanta Pro Plumbing");
    expect(res.body.data.status).toBe("new");
    expect(res.body.data.source).toBe("website");

    const savedDemoRequest = await DemoRequest.findOne({
      email: "john@example.com",
    });

    expect(savedDemoRequest).toBeTruthy();
    expect(savedDemoRequest.businessName).toBe("Atlanta Pro Plumbing");
  });

  test("POST /api/demo-requests rejects invalid demo request data", async () => {
    const res = await request(app).post("/api/demo-requests").send({
      fullName: "",
      email: "not-an-email",
      businessName: "",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/demo-requests accepts optional fields as empty strings", async () => {
    const res = await request(app)
      .post("/api/demo-requests")
      .send(
        createDemoRequestPayload({
          phone: "",
          businessType: "",
          website: "",
          preferredTime: "",
          message: "",
        }),
      );

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.phone).toBe("");
    expect(res.body.data.businessType).toBe("");
    expect(res.body.data.website).toBe("");
  });

  test("GET /api/demo-requests rejects unauthenticated request", async () => {
    const res = await request(app).get("/api/demo-requests");

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/demo-requests rejects non-admin user", async () => {
    const { token } = await registerOwner();

    const res = await request(app)
      .get("/api/demo-requests")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/demo-requests returns demo requests for admin", async () => {
    const { token } = await registerAdmin();

    await DemoRequest.create(createDemoRequestPayload());
    await DemoRequest.create(
      createDemoRequestPayload({
        fullName: "Jane Doe",
        email: "jane@example.com",
        businessName: "Jane HVAC",
      }),
    );

    const res = await request(app)
      .get("/api/demo-requests")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBe(2);
    expect(res.body.data[0]).toHaveProperty("fullName");
    expect(res.body.data[0]).toHaveProperty("email");
  });

  test("GET /api/demo-requests?status=new filters demo requests by status", async () => {
    const { token } = await registerAdmin();

    await DemoRequest.create(createDemoRequestPayload({ status: "new" }));
    await DemoRequest.create(
      createDemoRequestPayload({
        fullName: "Scheduled Lead",
        email: "scheduled@example.com",
        businessName: "Scheduled HVAC",
        status: "scheduled",
      }),
    );

    const res = await request(app)
      .get("/api/demo-requests?status=new")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].status).toBe("new");
  });

  test("GET /api/demo-requests/:id returns demo request by id for admin", async () => {
    const { token } = await registerAdmin();

    const demoRequest = await DemoRequest.create(createDemoRequestPayload());

    const res = await request(app)
      .get(`/api/demo-requests/${demoRequest._id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data._id).toBe(String(demoRequest._id));
    expect(res.body.data.email).toBe("john@example.com");
  });

  test("GET /api/demo-requests/:id rejects invalid id", async () => {
    const { token } = await registerAdmin();

    const res = await request(app)
      .get("/api/demo-requests/bad-id")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("PATCH /api/demo-requests/:id updates and schedules demo request for admin", async () => {
    const { token } = await registerAdmin();

    const demoRequest = await DemoRequest.create(createDemoRequestPayload());
    const availabilityRes = await request(app).get(
      "/api/demo-requests/availability",
    );

    expect(availabilityRes.status).toBe(200);
    const scheduledAt = availabilityRes.body.data?.slots?.[0]?.start;
    expect(scheduledAt).toBeTruthy();

    const res = await request(app)
      .patch(`/api/demo-requests/${demoRequest._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        status: "scheduled",
        scheduledAt,
        adminNotes: "Demo scheduled for Friday.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("scheduled");
    expect(res.body.data.scheduledAt).toBe(scheduledAt);
    expect(res.body.data.scheduledEndAt).toBeTruthy();
    expect(res.body.data.adminNotes).toBe("Demo scheduled for Friday.");
  });

  test("PATCH /api/demo-requests/:id rejects scheduled status without an appointment time", async () => {
    const { token } = await registerAdmin();
    const demoRequest = await DemoRequest.create(createDemoRequestPayload());

    const res = await request(app)
      .patch(`/api/demo-requests/${demoRequest._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        status: "scheduled",
        adminNotes: "Should not become scheduled without a real slot.",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/requires a scheduled date and time/i);
  });
  test("PATCH /api/demo-requests/:id sets contactedAt when status is contacted", async () => {
    const { token } = await registerAdmin();

    const demoRequest = await DemoRequest.create(createDemoRequestPayload());

    const res = await request(app)
      .patch(`/api/demo-requests/${demoRequest._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        status: "contacted",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("contacted");
    expect(res.body.data.contactedAt).toBeTruthy();
  });

  test("PATCH /api/demo-requests/:id rejects invalid status", async () => {
    const { token } = await registerAdmin();

    const demoRequest = await DemoRequest.create(createDemoRequestPayload());

    const res = await request(app)
      .patch(`/api/demo-requests/${demoRequest._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        status: "bad_status",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("PATCH /api/demo-requests/:id rejects empty update body", async () => {
    const { token } = await registerAdmin();

    const demoRequest = await DemoRequest.create(createDemoRequestPayload());

    const res = await request(app)
      .patch(`/api/demo-requests/${demoRequest._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("DELETE /api/demo-requests/:id deletes demo request for admin", async () => {
    const { token } = await registerAdmin();

    const demoRequest = await DemoRequest.create(createDemoRequestPayload());

    const res = await request(app)
      .delete(`/api/demo-requests/${demoRequest._id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const deletedDemoRequest = await DemoRequest.findById(demoRequest._id);

    expect(deletedDemoRequest).toBeFalsy();
  });

  test("DELETE /api/demo-requests/:id rejects invalid id", async () => {
    const { token } = await registerAdmin();

    const res = await request(app)
      .delete("/api/demo-requests/bad-id")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
