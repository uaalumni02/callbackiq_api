import mongoose from "mongoose";
import Alert from "../../src/models/alert.js";
import AutomationJob from "../../src/models/automationJob.js";
import AutomationWorkflow from "../../src/models/automationWorkflow.js";
import Business from "../../src/models/business.js";
import IntegrationConnection from "../../src/models/integrationConnection.js";
import GoogleCalendarProvider from "../../src/integrations/scheduling/googleCalendar.provider.js";
import JobberProvider from "../../src/integrations/scheduling/jobber.provider.js";
import AppointmentController from "../../src/controllers/appointment.js";
import AutomationController from "../../src/controllers/automation.js";
import AvailabilityController from "../../src/controllers/availability.js";
import IntegrationController from "../../src/controllers/integration.js";
import InterventionController from "../../src/controllers/intervention.js";
import RevenueRecoveryController from "../../src/controllers/revenueRecovery.js";
import getOwnedBusiness from "../../src/services/businessScope.service.js";
import AppointmentService from "../../src/services/scheduling/appointment.service.js";
import AvailabilityService from "../../src/services/scheduling/availability.service.js";
import RevenueRecoveryService from "../../src/services/analytics/revenueRecovery.service.js";
import SocketService from "../../src/services/socket.service.js";
import {
  buildGoogleAuthorizationUrl,
  disconnectGoogleCalendar,
  exchangeGoogleAuthorizationCode,
  getGoogleConnection,
  listGoogleCalendars,
  selectGoogleCalendar,
} from "../../src/services/integrations/googleCalendarConnection.service.js";
import {
  buildJobberAuthorizationUrl,
  disconnectJobber,
  exchangeJobberAuthorizationCode,
} from "../../src/services/integrations/jobberOAuth.service.js";

jest.mock("mongoose", () => ({
  __esModule: true,
  default: { Types: { ObjectId: jest.fn(function ObjectId(value) { return { value: `oid:${value}` }; }) } },
}));
jest.mock("../../src/models/alert.js", () => ({ __esModule: true, default: { find: jest.fn(), findOneAndUpdate: jest.fn() } }));
jest.mock("../../src/models/automationJob.js", () => ({ __esModule: true, default: { find: jest.fn(), updateMany: jest.fn() } }));
jest.mock("../../src/models/automationWorkflow.js", () => ({
  __esModule: true,
  default: {
    find: jest.fn(),
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findOneAndDelete: jest.fn(),
  },
}));
jest.mock("../../src/models/business.js", () => ({ __esModule: true, default: { updateOne: jest.fn() } }));
jest.mock("../../src/models/integrationConnection.js", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../src/integrations/scheduling/googleCalendar.provider.js", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/integrations/scheduling/jobber.provider.js", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/services/businessScope.service.js", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../src/services/scheduling/appointment.service.js", () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
    releaseExpiredHolds: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    confirm: jest.fn(),
    cancel: jest.fn(),
    reschedule: jest.fn(),
  },
}));
jest.mock("../../src/services/scheduling/availability.service.js", () => ({ __esModule: true, default: { getAvailability: jest.fn() } }));
jest.mock("../../src/services/analytics/revenueRecovery.service.js", () => ({
  __esModule: true,
  default: {
    summary: jest.fn(),
    trends: jest.fn(),
    sources: jest.fn(),
    lostOpportunities: jest.fn(),
    funnel: jest.fn(),
  },
}));
jest.mock("../../src/services/socket.service.js", () => ({ __esModule: true, default: { emitAlertUpdated: jest.fn() } }));
jest.mock("../../src/services/integrations/googleCalendarConnection.service.js", () => ({
  __esModule: true,
  buildGoogleAuthorizationUrl: jest.fn(),
  disconnectGoogleCalendar: jest.fn(),
  exchangeGoogleAuthorizationCode: jest.fn(),
  getGoogleConnection: jest.fn(),
  listGoogleCalendars: jest.fn(),
  selectGoogleCalendar: jest.fn(),
}));
jest.mock("../../src/services/integrations/jobberOAuth.service.js", () => ({
  __esModule: true,
  buildJobberAuthorizationUrl: jest.fn(),
  disconnectJobber: jest.fn(),
  exchangeJobberAuthorizationCode: jest.fn(),
}));

const business = { _id: "b1" };
const makeRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  redirect: jest.fn().mockReturnThis(),
});
const makeReq = (overrides = {}) => ({
  user: { userId: "u1" },
  query: {},
  body: {},
  params: { id: "id1" },
  get: jest.fn().mockReturnValue(null),
  ...overrides,
});

const chain = (resolvedValue) => {
  const query = {
    populate: jest.fn(),
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn().mockResolvedValue(resolvedValue),
  };
  query.populate.mockReturnValue(query);
  query.sort.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.then = (resolve, reject) => Promise.resolve(resolvedValue).then(resolve, reject);
  return query;
};

describe("Phase 2-8 controllers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, FRONTEND_URL: "https://app.example.com/" };
    getOwnedBusiness.mockResolvedValue(business);
    Business.updateOne.mockResolvedValue({ acknowledged: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe("AvailabilityController", () => {
    test("requires service and date parameters", async () => {
      const req = makeReq({ query: { businessId: "b1" } });
      const res = makeRes();
      const next = jest.fn();
      await AvailabilityController.list(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: "serviceOfferingId, startDate, and endDate are required.",
      });
      expect(next).not.toHaveBeenCalled();
    });

    test("returns availability", async () => {
      AvailabilityService.getAvailability.mockResolvedValue({ slots: [{ startAt: "date" }], timezone: "UTC" });
      const req = makeReq({ query: {
        businessId: "b1",
        serviceOfferingId: "s1",
        startDate: "2026-07-27",
        endDate: "2026-07-28",
        postalCode: "30318",
      } });
      const res = makeRes();
      await AvailabilityController.list(req, res, jest.fn());
      expect(AvailabilityService.getAvailability).toHaveBeenCalledWith({
        business,
        serviceOfferingId: "s1",
        startDate: "2026-07-27",
        endDate: "2026-07-28",
        postalCode: "30318",
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ success: true, slots: [{ startAt: "date" }], timezone: "UTC" });
    });

    test("forwards availability errors", async () => {
      const error = new Error("scope failed");
      getOwnedBusiness.mockRejectedValue(error);
      const next = jest.fn();
      await AvailabilityController.list(makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalledWith(error);
    });
  });

  describe("AppointmentController", () => {
    test.each([
      ["confirmed", 201],
      ["held", 202],
    ])("creates a %s appointment with status %s", async (status, httpStatus) => {
      const appointment = { _id: "a1", status };
      AppointmentService.create.mockResolvedValue(appointment);
      const req = makeReq({
        body: { businessId: "b1", idempotencyKey: "body-key", confirm: status === "confirmed" },
        get: jest.fn().mockReturnValue("header-key"),
      });
      const res = makeRes();
      await AppointmentController.create(req, res, jest.fn());
      expect(AppointmentService.create).toHaveBeenCalledWith({
        business,
        input: req.body,
        idempotencyKey: "header-key",
        confirm: status === "confirmed",
      });
      expect(res.status).toHaveBeenCalledWith(httpStatus);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: appointment });
    });

    test("uses body idempotency key and defaults confirm to true", async () => {
      AppointmentService.create.mockResolvedValue({ status: "confirmed" });
      const req = makeReq({ body: { idempotencyKey: "body-key" } });
      await AppointmentController.create(req, makeRes(), jest.fn());
      expect(AppointmentService.create).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "body-key", confirm: true }));
    });

    test("lists appointments after releasing expired holds", async () => {
      AppointmentService.list.mockResolvedValue([{ _id: "a1" }]);
      const req = makeReq({ query: { businessId: "b1", status: "confirmed" } });
      const res = makeRes();
      await AppointmentController.list(req, res, jest.fn());
      expect(AppointmentService.releaseExpiredHolds).toHaveBeenCalledWith("b1");
      expect(AppointmentService.list).toHaveBeenCalledWith({ businessId: "b1", query: req.query });
      expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ _id: "a1" }] });
    });

    test("gets an appointment or returns 404", async () => {
      AppointmentService.get.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: "a1" });
      const req = makeReq({ query: { businessId: "b1" }, params: { id: "a1" } });
      const firstRes = makeRes();
      await AppointmentController.get(req, firstRes, jest.fn());
      expect(firstRes.status).toHaveBeenCalledWith(404);
      const secondRes = makeRes();
      await AppointmentController.get(req, secondRes, jest.fn());
      expect(secondRes.status).toHaveBeenCalledWith(200);
      expect(secondRes.json).toHaveBeenCalledWith({ success: true, data: { _id: "a1" } });
    });

    test("updates, confirms, cancels, and reschedules", async () => {
      AppointmentService.update.mockResolvedValue({ _id: "a1", notes: "updated" });
      AppointmentService.confirm.mockResolvedValue({ _id: "a1", status: "confirmed" });
      AppointmentService.cancel.mockResolvedValue({ _id: "a1", status: "canceled" });
      AppointmentService.reschedule.mockResolvedValue({ _id: "a2", status: "confirmed" });
      const base = makeReq({ body: { businessId: "b1", notes: "updated", reason: "Customer request", idempotencyKey: "reschedule-key" }, params: { id: "a1" } });
      await AppointmentController.update(base, makeRes(), jest.fn());
      await AppointmentController.confirm(base, makeRes(), jest.fn());
      await AppointmentController.cancel(base, makeRes(), jest.fn());
      await AppointmentController.reschedule(base, makeRes(), jest.fn());
      expect(AppointmentService.update).toHaveBeenCalledWith({ businessId: "b1", appointmentId: "a1", changes: base.body });
      expect(AppointmentService.confirm).toHaveBeenCalledWith({ business, appointmentId: "a1" });
      expect(AppointmentService.cancel).toHaveBeenCalledWith({ business, appointmentId: "a1", reason: "Customer request" });
      expect(AppointmentService.reschedule).toHaveBeenCalledWith({ business, appointmentId: "a1", input: base.body, idempotencyKey: "reschedule-key" });
    });

    test("uses an empty cancellation reason", async () => {
      AppointmentService.cancel.mockResolvedValue({});
      await AppointmentController.cancel(makeReq({ body: {}, params: { id: "a1" } }), makeRes(), jest.fn());
      expect(AppointmentService.cancel).toHaveBeenCalledWith(expect.objectContaining({ reason: "" }));
    });

    test.each(["create", "list", "get", "update", "confirm", "cancel", "reschedule"])("forwards %s errors", async (method) => {
      const error = new Error(`${method} failed`);
      getOwnedBusiness.mockRejectedValue(error);
      const next = jest.fn();
      await AppointmentController[method](makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalledWith(error);
    });
  });

  describe("AutomationController", () => {
    test("lists workflows", async () => {
      const query = chain([{ _id: "w1" }]);
      AutomationWorkflow.find.mockReturnValue(query);
      const res = makeRes();
      await AutomationController.listWorkflows(makeReq({ query: { businessId: "b1" } }), res, jest.fn());
      expect(AutomationWorkflow.find).toHaveBeenCalledWith({ business: "b1" });
      expect(query.sort).toHaveBeenCalledWith({ createdAt: 1 });
      expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ _id: "w1" }] });
    });

    test("creates a workflow scoped to the business", async () => {
      AutomationWorkflow.create.mockResolvedValue({ _id: "w1" });
      const req = makeReq({ body: { businessId: "wrong", name: "Follow up" } });
      const res = makeRes();
      await AutomationController.createWorkflow(req, res, jest.fn());
      expect(AutomationWorkflow.create).toHaveBeenCalledWith({ businessId: "wrong", name: "Follow up", business: "b1" });
      expect(res.status).toHaveBeenCalledWith(201);
    });

    test("updates only allowed workflow fields and returns 404 when missing", async () => {
      AutomationWorkflow.findOneAndUpdate
        .mockResolvedValueOnce({ _id: "w1", name: "New" })
        .mockResolvedValueOnce(null);
      const req = makeReq({ body: { businessId: "b1", name: "New", enabled: false, forbidden: "ignore" }, params: { id: "w1" } });
      const firstRes = makeRes();
      await AutomationController.updateWorkflow(req, firstRes, jest.fn());
      expect(AutomationWorkflow.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: "w1", business: "b1" },
        { $set: { name: "New", enabled: false } },
        { new: true, runValidators: true },
      );
      const secondRes = makeRes();
      await AutomationController.updateWorkflow(req, secondRes, jest.fn());
      expect(secondRes.status).toHaveBeenCalledWith(404);
    });

    test("deletes a workflow and cancels active jobs", async () => {
      AutomationWorkflow.findOneAndDelete.mockResolvedValue({ _id: "w1" });
      const res = makeRes();
      await AutomationController.deleteWorkflow(makeReq({ query: { businessId: "b1" }, params: { id: "w1" } }), res, jest.fn());
      expect(AutomationJob.updateMany).toHaveBeenCalledWith(
        { workflow: "w1", status: { $in: ["scheduled", "processing"] } },
        { $set: { status: "canceled", canceledAt: expect.any(Date), failureReason: "workflow_deleted" } },
      );
      expect(res.json).toHaveBeenCalledWith({ success: true, message: "Workflow deleted." });
    });

    test("returns 404 for a missing workflow on delete", async () => {
      AutomationWorkflow.findOneAndDelete.mockResolvedValue(null);
      const res = makeRes();
      await AutomationController.deleteWorkflow(makeReq(), res, jest.fn());
      expect(res.status).toHaveBeenCalledWith(404);
      expect(AutomationJob.updateMany).not.toHaveBeenCalled();
    });

    test("lists filtered jobs with a capped limit", async () => {
      const query = chain([{ _id: "j1" }]);
      AutomationJob.find.mockReturnValue(query);
      const req = makeReq({ query: { businessId: "b1", status: "scheduled", conversationId: "c1", limit: "999" } });
      const res = makeRes();
      await AutomationController.listJobs(req, res, jest.fn());
      expect(AutomationJob.find).toHaveBeenCalledWith({ business: "b1", status: "scheduled", conversation: "c1" });
      expect(query.populate).toHaveBeenCalledTimes(2);
      expect(query.sort).toHaveBeenCalledWith({ executeAt: -1 });
      expect(query.limit).toHaveBeenCalledWith(250);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ _id: "j1" }] });
    });

    test("uses default list limit and no optional filters", async () => {
      const query = chain([]);
      AutomationJob.find.mockReturnValue(query);
      await AutomationController.listJobs(makeReq(), makeRes(), jest.fn());
      expect(AutomationJob.find).toHaveBeenCalledWith({ business: "b1" });
      expect(query.limit).toHaveBeenCalledWith(100);
    });

    test.each(["listWorkflows", "createWorkflow", "updateWorkflow", "deleteWorkflow", "listJobs"])("forwards %s errors", async (method) => {
      const error = new Error("failed");
      getOwnedBusiness.mockRejectedValue(error);
      const next = jest.fn();
      await AutomationController[method](makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalledWith(error);
    });
  });

  describe("InterventionController", () => {
    test.each([
      [{}, expect.objectContaining({ resolvedAt: null })],
      [{ resolved: "true" }, expect.objectContaining({ resolvedAt: { $ne: null } })],
      [{ resolved: "all" }, expect.not.objectContaining({ resolvedAt: expect.anything() })],
    ])("builds list filters %#", async (queryValues, expectedFilter) => {
      const query = chain([{ _id: "alert1" }]);
      Alert.find.mockReturnValue(query);
      const req = makeReq({ query: { businessId: "b1", ...queryValues, priority: "high", assignedTo: "u2", limit: "300" } });
      const res = makeRes();
      await InterventionController.list(req, res, jest.fn());
      expect(Alert.find.mock.calls[0][0]).toEqual(expectedFilter);
      expect(Alert.find.mock.calls[0][0]).toMatchObject({ business: "b1", priority: "high", assignedTo: "u2" });
      expect(query.populate).toHaveBeenCalledTimes(4);
      expect(query.limit).toHaveBeenCalledWith(250);
      expect(res.json).toHaveBeenCalledWith({ success: true, data: [{ _id: "alert1" }] });
    });

    test("queries enough records for severity ordering and returns the default 100", async () => {
      const alerts = Array.from({ length: 101 }, (_, index) => ({
        _id: `alert-${index}`,
        priority: index === 100 ? "critical" : "low",
        createdAt: new Date(2026, 6, 27, 12, 0, index).toISOString(),
      }));
      const query = chain(alerts);
      const res = makeRes();

      Alert.find.mockReturnValue(query);
      await InterventionController.list(makeReq(), res, jest.fn());

      expect(query.limit).toHaveBeenCalledWith(250);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.any(Array),
      });
      expect(res.json.mock.calls[0][0].data).toHaveLength(100);
      expect(res.json.mock.calls[0][0].data[0]._id).toBe("alert-100");
    });

    test.each([
      ["acknowledge", { body: {}, expectedUpdate: expect.objectContaining({ status: "acknowledged", assignedTo: "u1" }) }],
      ["resolve", { body: {}, expectedUpdate: expect.objectContaining({ status: "resolved", resolution: "Resolved by staff.", actionRequired: false }) }],
      ["assign", { body: {}, expectedUpdate: { assignedTo: null } }],
    ])("%s returns 404 or updates an intervention", async (method, config) => {
      const missingQuery = chain(null);
      Alert.findOneAndUpdate.mockReturnValueOnce(missingQuery);
      const missingRes = makeRes();
      await InterventionController[method](makeReq({ body: config.body }), missingRes, jest.fn());
      expect(missingRes.status).toHaveBeenCalledWith(404);

      const alert = { _id: "alert1" };
      const foundQuery = chain(alert);
      Alert.findOneAndUpdate.mockReturnValueOnce(foundQuery);
      const foundRes = makeRes();
      await InterventionController[method](makeReq({ body: config.body }), foundRes, jest.fn());
      expect(Alert.findOneAndUpdate.mock.calls[1][1].$set).toEqual(config.expectedUpdate);
      expect(SocketService.emitAlertUpdated).toHaveBeenCalledWith("b1", alert);
      expect(foundRes.json).toHaveBeenCalledWith({ success: true, data: alert });
    });

    test("uses supplied assignee and resolution", async () => {
      Alert.findOneAndUpdate.mockReturnValueOnce(chain({ _id: "a1" })).mockReturnValueOnce(chain({ _id: "a2" }));
      await InterventionController.acknowledge(makeReq({ body: { assignedTo: "u2" } }), makeRes(), jest.fn());
      await InterventionController.resolve(makeReq({ body: { resolution: "Called customer" } }), makeRes(), jest.fn());
      expect(Alert.findOneAndUpdate.mock.calls[0][1].$set.assignedTo).toBe("u2");
      expect(Alert.findOneAndUpdate.mock.calls[1][1].$set.resolution).toBe("Called customer");
    });

    test.each(["list", "acknowledge", "resolve", "assign"])("forwards %s errors", async (method) => {
      const error = new Error("failed");
      getOwnedBusiness.mockRejectedValue(error);
      const next = jest.fn();
      await InterventionController[method](makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalledWith(error);
    });
  });

  describe("RevenueRecoveryController", () => {
    test.each([
      ["summary", "summary", { total: 1 }],
      ["trends", "trends", [{ date: "2026-07-27" }]],
      ["sources", "sources", [{ source: "sms" }]],
      ["funnel", "funnel", { booked: 1 }],
    ])("returns %s analytics", async (controllerMethod, serviceMethod, data) => {
      RevenueRecoveryService[serviceMethod].mockResolvedValue(data);
      const req = makeReq({ query: { businessId: "b1", startDate: "2026-07-01", endDate: "2026-07-31" } });
      const res = makeRes();
      await RevenueRecoveryController[controllerMethod](req, res, jest.fn());
      expect(mongoose.Types.ObjectId).toHaveBeenCalledWith("b1");
      expect(RevenueRecoveryService[serviceMethod]).toHaveBeenCalledWith({
        businessId: { value: "oid:b1" },
        startDate: "2026-07-01",
        endDate: "2026-07-31",
      });
      expect(res.json).toHaveBeenCalledWith({ success: true, data });
    });

    test("passes limit to lost opportunities", async () => {
      RevenueRecoveryService.lostOpportunities.mockResolvedValue([]);
      const req = makeReq({ query: { limit: "25" } });
      await RevenueRecoveryController.lost(req, makeRes(), jest.fn());
      expect(RevenueRecoveryService.lostOpportunities).toHaveBeenCalledWith(expect.objectContaining({ limit: "25" }));
    });

    test.each(["summary", "trends", "sources", "lost", "funnel"])("forwards %s errors", async (method) => {
      const error = new Error("failed");
      getOwnedBusiness.mockRejectedValue(error);
      const next = jest.fn();
      await RevenueRecoveryController[method](makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalledWith(error);
    });
  });

  describe("IntegrationController", () => {
    const publicConnection = {
      provider: "google_calendar",
      status: "connected",
      scopes: ["scope"],
      providerAccountId: "account",
      providerCalendarId: "calendar",
      apiVersion: "v1",
      metadata: { name: "Bookings" },
      lastSuccessfulSyncAt: "success-date",
      lastErrorAt: null,
      lastErrorMessage: "",
      updatedAt: "updated-date",
      secret: "must-not-leak",
    };

    test("connects Google", async () => {
      buildGoogleAuthorizationUrl.mockResolvedValue("https://google/auth");
      const res = makeRes();
      await IntegrationController.googleConnect(makeReq({ query: { businessId: "b1" } }), res, jest.fn());
      expect(res.json).toHaveBeenCalledWith({ success: true, data: { authorizationUrl: "https://google/auth" } });
    });

    test("handles successful and failed Google callbacks", async () => {
      exchangeGoogleAuthorizationCode.mockResolvedValue({ businessId: "b1" });
      const successRes = makeRes();
      await IntegrationController.googleCallback(makeReq({ query: { code: "code", state: "state" } }), successRes);
      expect(Business.updateOne).toHaveBeenCalledWith({ _id: "b1" }, { $set: expect.objectContaining({ "integrations.calendar.provider": "google" }) });
      expect(successRes.redirect).toHaveBeenCalledWith("https://app.example.com/integrations?google=connected");

      const failedRes = makeRes();
      await IntegrationController.googleCallback(makeReq({ query: {} }), failedRes);
      expect(failedRes.redirect.mock.calls[0][0]).toContain("google=error");
      expect(failedRes.redirect.mock.calls[0][0]).toContain("authorization%20code");
    });

    test("returns Google status for connected and absent connections", async () => {
      getGoogleConnection.mockResolvedValueOnce(publicConnection).mockResolvedValueOnce(null);
      const connectedRes = makeRes();
      await IntegrationController.googleStatus(makeReq(), connectedRes, jest.fn());
      expect(connectedRes.json.mock.calls[0][0].data).toEqual({
        provider: "google_calendar",
        status: "connected",
        scopes: ["scope"],
        providerAccountId: "account",
        providerCalendarId: "calendar",
        apiVersion: "v1",
        metadata: { name: "Bookings" },
        lastSuccessfulSyncAt: "success-date",
        lastErrorAt: null,
        lastErrorMessage: "",
        updatedAt: "updated-date",
      });
      const absentRes = makeRes();
      await IntegrationController.googleStatus(makeReq(), absentRes, jest.fn());
      expect(absentRes.json).toHaveBeenCalledWith({ success: true, data: { status: "disconnected" } });
    });

    test("lists and selects Google calendars", async () => {
      listGoogleCalendars.mockResolvedValue([{ id: "cal1" }]);
      selectGoogleCalendar.mockResolvedValue(publicConnection);
      const listRes = makeRes();
      await IntegrationController.googleCalendars(makeReq(), listRes, jest.fn());
      expect(listRes.json).toHaveBeenCalledWith({ success: true, data: [{ id: "cal1" }] });
      const selectRes = makeRes();
      await IntegrationController.googleSelectCalendar(makeReq({ body: { businessId: "b1", calendarId: "cal1" } }), selectRes, jest.fn());
      expect(selectGoogleCalendar).toHaveBeenCalledWith({ businessId: "b1", calendarId: "cal1" });
      expect(Business.updateOne).toHaveBeenCalledWith({ _id: "b1" }, { $set: expect.objectContaining({ "features.calendarProvider": "google", "integrations.calendar.verified": true }) });
      expect(selectRes.json.mock.calls[0][0].data.secret).toBeUndefined();
    });

    test("disconnects and tests Google", async () => {
      disconnectGoogleCalendar.mockResolvedValue({ ...publicConnection, status: "disconnected" });
      const testConnection = jest.fn().mockResolvedValue({ connected: true });
      GoogleCalendarProvider.mockImplementation(() => ({ testConnection }));
      await IntegrationController.googleDisconnect(makeReq(), makeRes(), jest.fn());
      expect(Business.updateOne).toHaveBeenCalledWith({ _id: "b1" }, { $set: expect.objectContaining({ "features.calendarProvider": "internal", "integrations.calendar.status": "disconnected" }) });
      const testRes = makeRes();
      await IntegrationController.googleTest(makeReq(), testRes, jest.fn());
      expect(GoogleCalendarProvider).toHaveBeenCalledWith({ business });
      expect(testRes.json).toHaveBeenCalledWith({ success: true, data: { connected: true } });
    });

    test("connects Jobber and handles callbacks", async () => {
      buildJobberAuthorizationUrl.mockResolvedValue("https://jobber/auth");
      const connectRes = makeRes();
      await IntegrationController.jobberConnect(makeReq(), connectRes, jest.fn());
      expect(connectRes.json).toHaveBeenCalledWith({ success: true, data: { authorizationUrl: "https://jobber/auth" } });

      exchangeJobberAuthorizationCode.mockResolvedValue({ businessId: "b1" });
      const callbackRes = makeRes();
      await IntegrationController.jobberCallback(makeReq({ query: { code: "code", state: "state" } }), callbackRes);
      expect(callbackRes.redirect).toHaveBeenCalledWith("https://app.example.com/integrations?jobber=connected");
      expect(Business.updateOne).toHaveBeenCalledWith({ _id: "b1" }, { $set: expect.objectContaining({ "integrations.dispatch.provider": "jobber", "integrations.dispatch.verified": true }) });

      const failureRes = makeRes();
      await IntegrationController.jobberCallback(makeReq({ query: {} }), failureRes);
      expect(failureRes.redirect.mock.calls[0][0]).toContain("jobber=error");
    });

    test("disconnects, reports status, and tests Jobber", async () => {
      disconnectJobber.mockResolvedValue({ ...publicConnection, provider: "jobber", status: "disconnected" });
      const disconnectRes = makeRes();
      await IntegrationController.jobberDisconnect(makeReq(), disconnectRes, jest.fn());
      expect(Business.updateOne).toHaveBeenCalledWith({ _id: "b1" }, { $set: expect.objectContaining({ "integrations.dispatch.provider": "", "integrations.dispatch.verified": false }) });

      IntegrationConnection.findOne.mockResolvedValue(null);
      const statusRes = makeRes();
      await IntegrationController.jobberStatus(makeReq(), statusRes, jest.fn());
      expect(statusRes.json).toHaveBeenCalledWith({ success: true, data: { status: "disconnected" } });

      const testConnection = jest.fn().mockResolvedValue({ connected: true, provider: "jobber" });
      JobberProvider.mockImplementation(() => ({ testConnection }));
      const testRes = makeRes();
      await IntegrationController.jobberTest(makeReq(), testRes, jest.fn());
      expect(testRes.json).toHaveBeenCalledWith({ success: true, data: { connected: true, provider: "jobber" } });
    });

    test.each([
      "googleConnect",
      "googleStatus",
      "googleCalendars",
      "googleSelectCalendar",
      "googleDisconnect",
      "googleTest",
      "jobberConnect",
      "jobberDisconnect",
      "jobberStatus",
      "jobberTest",
    ])("forwards %s errors", async (method) => {
      const error = new Error("failed");
      getOwnedBusiness.mockRejectedValue(error);
      const next = jest.fn();
      await IntegrationController[method](makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalledWith(error);
    });
  });
});
