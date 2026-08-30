import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import app from "../../src/app.js";
import Token from "../../src/helpers/jwt/token.js";

import User from "../../src/models/user.js";
import Business from "../../src/models/business.js";
import Subscription from "../../src/models/subscription.js";
import Lead from "../../src/models/lead.js";

import SocketService from "../../src/services/socket.service.js";

jest.mock("../../src/services/socket.service.js", () => ({
  __esModule: true,
  default: {
    emitLeadCreated: jest.fn(),
    emitAlertCreated: jest.fn(),
    emitLeadUpdated: jest.fn(),
    emitDashboardRefresh: jest.fn(),
    emitToBusiness: jest.fn(),
  },
}));

jest.setTimeout(30000);

describe("Lead Socket.IO route integration", () => {
  let mongoServer;
  let owner;
  let business;
  let token;

  const validLeadPayload = {
    customerName: "Michael Johnson",
    phone: "4045551001",
    email: "michael.johnson@example.com",
    serviceNeeded: "Burst water pipe",
    urgency: "emergency",
    address: "742 Peachtree Street NE, Atlanta, GA 30308",
    preferredAppointmentTime: "Immediately",
    leadQualityScore: 95,
    estimatedValue: 2800,
    status: "new",
    source: "manual",
    summary:
      "Customer has a burst water pipe causing flooding in the basement.",
    notes: "Customer shut off the main water valve.",
  };

  beforeAll(async () => {
    /*
     * This test suite needs its own database connection because app.js only
     * configures Express. Importing app.js does not call connectDB().
     */
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }

    mongoServer = await MongoMemoryServer.create();

    await mongoose.connect(mongoServer.getUri());

    owner = await User.create({
      userName: "sockettestowner",
      email: "socket-test-owner@callbackiq.com",
      password: "hashed-test-password",
      role: "owner",
      businessName: "Atlanta Pro Plumbing & Drain",
      businessPhone: "4045550100",
      businessType: "plumbing",
      smsConsent: true,
      smsConsentAt: new Date(),
      termsAccepted: true,
      termsAcceptedAt: new Date(),
      privacyAccepted: true,
      privacyAcceptedAt: new Date(),
    });

    business = await Business.create({
      owner: owner._id,
      businessName: "Atlanta Pro Plumbing & Drain",
      businessType: "plumbing",
      phone: "4045550100",
      forwardingPhone: "4045550199",
      email: "socket-test-owner@callbackiq.com",
      timezone: "America/New_York",
      estimatedJobValue: 1500,
      isActive: true,
    });

    await Subscription.create({
      business: business._id,
      plan: "pro",
      status: "active",
      priceMonthly: 99,
      aiEnabled: true,
      isActive: true,
      cancelAtPeriodEnd: false,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      lastPaymentStatus: "paid",
    });

    token = Token.sign({
      userId: owner._id,
      userName: owner.userName,
      email: owner.email,
      role: owner.role,
    });
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await Lead.deleteMany({});
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }

    if (mongoServer) {
      await mongoServer.stop();
    }
  });

  describe("POST /api/leads", () => {
    test("creates a lead and emits real-time Socket.IO events", async () => {
      const response = await request(app)
        .post("/api/leads")
        .set("Authorization", `Bearer ${token}`)
        .send(validLeadPayload);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe("Lead created successfully");

      expect(response.body.data).toEqual(
        expect.objectContaining({
          customerName: "Michael Johnson",
          phone: "+14045551001",
          serviceNeeded: "Burst water pipe",
          urgency: "emergency",
          estimatedValue: 2800,
          status: "new",
          source: "manual",
        }),
      );

      const savedLead = await Lead.findById(response.body.data._id);

      expect(savedLead).not.toBeNull();
      expect(savedLead.customerName).toBe("Michael Johnson");
      expect(savedLead.business.toString()).toBe(business._id.toString());

      expect(SocketService.emitLeadCreated).toHaveBeenCalledTimes(1);

      const [emittedBusinessId, emittedLead] =
        SocketService.emitLeadCreated.mock.calls[0];

      expect(emittedBusinessId.toString()).toBe(business._id.toString());

      expect(emittedLead).toEqual(
        expect.objectContaining({
          customerName: "Michael Johnson",
          phone: "+14045551001",
          status: "new",
        }),
      );

      expect(emittedLead._id.toString()).toBe(savedLead._id.toString());

      expect(SocketService.emitDashboardRefresh).toHaveBeenCalledTimes(1);

      const [dashboardBusinessId, dashboardReason] =
        SocketService.emitDashboardRefresh.mock.calls[0];

      expect(dashboardBusinessId.toString()).toBe(business._id.toString());

      expect(dashboardReason).toBe("lead_created");
    });

    test("does not emit events when the request is unauthenticated", async () => {
      const response = await request(app)
        .post("/api/leads")
        .send(validLeadPayload);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(await Lead.countDocuments()).toBe(0);

      expect(SocketService.emitLeadCreated).not.toHaveBeenCalled();

      expect(SocketService.emitDashboardRefresh).not.toHaveBeenCalled();
    });

    test("does not emit events when lead validation fails", async () => {
      const response = await request(app)
        .post("/api/leads")
        .set("Authorization", `Bearer ${token}`)
        .send({
          customerName: "Invalid Lead",
          phone: "",
          serviceNeeded: "",
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(await Lead.countDocuments()).toBe(0);

      expect(SocketService.emitLeadCreated).not.toHaveBeenCalled();

      expect(SocketService.emitDashboardRefresh).not.toHaveBeenCalled();
    });
  });
});
