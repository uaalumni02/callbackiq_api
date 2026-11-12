import Db from "../../src/db/db.js";
import * as subscriptionRepository from "../../src/db/repositories/subscriptionRepository.js";
import * as supportTicketRepository from "../../src/db/repositories/supportTicketRepository.js";

jest.mock("../../src/db/repositories/subscriptionRepository.js", () => ({
  __esModule: true,
  getSubscriptionByBusiness: jest.fn(),
  getSubscriptionByStripeCustomer: jest.fn(),
  getSubscriptionByStripeSubscription: jest.fn(),
  upsertSubscriptionByBusiness: jest.fn(),
  updateSubscriptionByStripeSubscription: jest.fn(),
}));

jest.mock("../../src/db/repositories/supportTicketRepository.js", () => ({
  __esModule: true,
  saveSupportTicket: jest.fn(),
  getSupportTicketsByBusiness: jest.fn(),
  getSupportTicketForBusiness: jest.fn(),
  updateSupportTicketForBusiness: jest.fn(),
  closeSupportTicketForBusiness: jest.fn(),
  getAllSupportTickets: jest.fn(),
  updateSupportTicketAdmin: jest.fn(),
}));

const methods = [
  ["getSubscriptionByBusiness", subscriptionRepository],
  ["getSubscriptionByStripeCustomer", subscriptionRepository],
  ["getSubscriptionByStripeSubscription", subscriptionRepository],
  ["upsertSubscriptionByBusiness", subscriptionRepository],
  ["updateSubscriptionByStripeSubscription", subscriptionRepository],
  ["saveSupportTicket", supportTicketRepository],
  ["getSupportTicketsByBusiness", supportTicketRepository],
  ["getSupportTicketForBusiness", supportTicketRepository],
  ["updateSupportTicketForBusiness", supportTicketRepository],
  ["closeSupportTicketForBusiness", supportTicketRepository],
  ["getAllSupportTickets", supportTicketRepository],

];

beforeEach(() => jest.resetAllMocks());

test.each(methods)("Db.%s preserves arguments and results", async (method, repository) => {
  const model = { name: "fixture" };
  const result = { method };
  repository[method].mockResolvedValue(result);

  await expect(Db[method](model, "business-1", { flag: true })).resolves.toBe(result);
  expect(repository[method]).toHaveBeenCalledTimes(1);
  expect(repository[method]).toHaveBeenCalledWith(model, "business-1", { flag: true });
});

test.each(methods)("Db.%s preserves errors", async (method, repository) => {
  const failure = new Error(`repository failure: ${method}`);
  repository[method].mockRejectedValue(failure);

  await expect(Db[method]({})).rejects.toBe(failure);
  expect(repository[method]).toHaveBeenCalledTimes(1);
});

test('support administration is not an owner facade capability',()=>{expect(Db.updateSupportTicketAdmin).toBeUndefined();});
