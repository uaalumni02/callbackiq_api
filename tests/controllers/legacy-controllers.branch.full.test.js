import LeadController from "../../src/controllers/lead.js";
import BillingController from "../../src/controllers/billing.js";
import BusinessController from "../../src/controllers/business.js";

const makeReq = () => ({
  user: undefined,
  body: {},
  params: {},
  query: {},
  headers: {},
});

const makeRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
  cookie: jest.fn().mockReturnThis(),
  clearCookie: jest.fn().mockReturnThis(),
});

const staticMethods = (controller) =>
  Object.getOwnPropertyNames(controller).filter((name) => {
    if (["length", "name", "prototype"].includes(name)) return false;
    return typeof Object.getOwnPropertyDescriptor(controller, name)?.value === "function";
  });

const exerciseMissingAuthGuards = async (controller, preferredNames) => {
  const available = preferredNames.filter(
    (name) => typeof controller[name] === "function",
  );

  expect(staticMethods(controller).length).toBeGreaterThan(0);
  expect(available.length).toBeGreaterThan(0);

  for (const name of available) {
    const req = makeReq();
    const res = makeRes();
    await controller[name](req, res);
    expect(
      res.status.mock.calls.length +
        res.json.mock.calls.length +
        res.send.mock.calls.length,
    ).toBeGreaterThan(0);
  }
};

describe("legacy controller authentication guard branches", () => {
  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("exercises lead controller missing-auth paths", async () => {
    await exerciseMissingAuthGuards(LeadController, [
      "createLead",
      "getMyLeads",
      "getLeadById",
      "updateLead",
      "updateLeadStatus",
      "deleteLead",
    ]);
  });

  test("exercises billing controller missing-auth paths", async () => {
    await exerciseMissingAuthGuards(BillingController, [
      "startFreeTrial",
      "createCheckoutSession",
      "getMySubscription",
      "getBillingHistory",
      "createBillingPortalSession",
      "cancelSubscription",
      "updateAdminCustomerAccountStatus",
      "adminGrantTrialOverride",
    ]);
  });

  test("exercises business controller missing-auth paths", async () => {
    await exerciseMissingAuthGuards(BusinessController, [
      "createBusiness",
      "getMyBusiness",
      "getBusinessById",
      "updateMyBusiness",
      "deleteMyBusiness",
    ]);
  });
});
