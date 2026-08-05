import ContactPreference from "../../src/models/contactPreference.js";
import { processInboundSmsCommand } from "../../src/services/messaging/contactPreference.service.js";

jest.mock("../../src/models/contactPreference.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
}));

test("natural-language opt-out is persisted deterministically", async () => {
  ContactPreference.findOneAndUpdate.mockResolvedValue({ smsStatus: "opted_out" });
  const result = await processInboundSmsCommand({
    businessId: "business-1",
    phone: "+14045550101",
    messageBody: "Please stop texting me",
  });
  expect(result).toMatchObject({ handled: true, action: "opt_out", softOptOut: true });
  expect(ContactPreference.findOneAndUpdate).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      $set: expect.objectContaining({ smsStatus: "opted_out", source: "customer_request" }),
    }),
    expect.objectContaining({ returnDocument: "after", upsert: true }),
  );
});
