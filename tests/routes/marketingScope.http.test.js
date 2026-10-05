import express from "express";
import request from "supertest";
import router from "../../src/routes/marketingAttribution.routes.js";
import Business from "../../src/models/business.js";
import { getAttributionReport } from "../../src/services/marketingAttributionReport.service.js";
import { createMarketingSource } from "../../src/services/marketingSource.service.js";

// Only authentication/provider/data boundaries are replaced here. The actual
// Express router, controller and shared business-scope resolver run unchanged.
jest.mock("../../src/middleware/check-auth.js", () => ({ __esModule: true,
  default: (req, res, next) => {
    req.user = { userId: "owner-b", role: req.headers["x-test-role"] || "owner" };
    next();
  },
}));
jest.mock("../../src/middleware/check-subscription.js", () => ({ __esModule: true, default: (req, res, next) => next() }));
jest.mock("../../src/models/business.js", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../../src/services/marketingAttributionReport.service.js", () => ({ getAttributionReport: jest.fn() }));
jest.mock("../../src/services/marketingSource.service.js", () => ({
  archiveMarketingSource: jest.fn(), createMarketingSource: jest.fn(), listMarketingSources: jest.fn(),
  provisionMarketingTrackingNumber: jest.fn(), releaseMarketingTrackingNumber: jest.fn(), updateMarketingSource: jest.fn(),
}));
const A = { _id: "66c000000000000000000001", owner: "owner-a" };
const B = { _id: "66c000000000000000000002", owner: "owner-b" };
const app = express();
app.use(express.json());
app.use("/api/marketing-sources", router);
app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ success: false }));

beforeEach(() => {
  jest.clearAllMocks();
  Business.findOne.mockImplementation(async (query) => [A, B].find(row =>
    Object.entries(query).every(([key, value]) => row[key] === value)) || null);
  getAttributionReport.mockImplementation(async ({ businessId }) => [{ source: `source-${businessId}`, actualRevenue: businessId === B._id ? 425 : 900 }]);
  createMarketingSource.mockImplementation(async (input) => input);
});

test("scenario 26 rejects foreign ID with 404 before any report is read", async () => {
  const res = await request(app).get(`/api/marketing-sources/report?businessId=${A._id}`);
  expect(res.status).toBe(404);
  expect(res.body.success).toBe(false);
  expect(res.body.data).toBeUndefined();
  expect(getAttributionReport).not.toHaveBeenCalled();
});

test.each(["", `?businessId=${B._id}`])("own report retains response and recorded revenue: %s", async (suffix) => {
  const res = await request(app).get(`/api/marketing-sources/report${suffix}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, data: [{ source: `source-${B._id}`, actualRevenue: 425 }] });
});

test("date filters are passed through with authorized business ID", async () => {
  const res = await request(app).get(`/api/marketing-sources/report?businessId=${B._id}&start=2026-10-01&end=2026-10-04`);
  expect(res.status).toBe(200);
  expect(getAttributionReport).toHaveBeenCalledWith({ businessId: B._id, start: "2026-10-01", end: "2026-10-04" });
});

test.each(["bad", `${A._id}&businessId=${B._id}`])("invalid or duplicate ID fails before report query: %s", async (id) => {
  const res = await request(app).get(`/api/marketing-sources/report?businessId=${id}`);
  expect(res.status).toBe(400);
  expect(getAttributionReport).not.toHaveBeenCalled();
});

test("foreign source creation is rejected before mutation", async () => {
  const res = await request(app).post(`/api/marketing-sources?businessId=${A._id}`).send({ name: "Wrong scope" });
  expect(res.status).toBe(404);
  expect(createMarketingSource).not.toHaveBeenCalled();
});

test("own source creation still succeeds", async () => {
  const res = await request(app).post(`/api/marketing-sources?businessId=${B._id}`).send({ name: "Own source", channel: "other" });
  expect(res.status).toBe(201);
  expect(res.body.data.businessId).toBe(B._id);
});

test("admin can explicitly select another business", async () => {
  const res = await request(app).get(`/api/marketing-sources/report?businessId=${A._id}`).set("x-test-role", "admin");
  expect(res.status).toBe(200);
  expect(res.body.data[0].source).toBe(`source-${A._id}`);
});
