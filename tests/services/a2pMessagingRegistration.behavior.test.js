import {
  attachPhoneNumberToBusinessMessagingRegistration,
} from "../../src/services/a2pMessagingRegistration.service.js";

const makeClient = ({ senders = [], campaigns = [], createError = null } = {}) => {
  const phoneNumberCreate = jest.fn(async ({ phoneNumberSid }) => {
    if (createError) throw createError;
    return { sid: phoneNumberSid, phoneNumberSid };
  });
  const phoneNumberList = jest.fn(async () => senders);
  const campaignList = jest.fn(async () => campaigns);

  const service = {
    phoneNumbers: { list: phoneNumberList, create: phoneNumberCreate },
    usAppToPerson: { list: campaignList },
  };
  const services = jest.fn(() => service);

  return {
    client: { messaging: { v1: { services } } },
    services,
    phoneNumberCreate,
    phoneNumberList,
    campaignList,
  };
};

const business = (messagingServiceSid = "MG11111111111111111111111111111111") => ({
  messagingCompliance: { messagingServiceSid },
});

describe("A2P sender association behavior", () => {
  test("adds a newly provisioned PN sender to the business Messaging Service", async () => {
    const twilio = makeClient({
      campaigns: [{ campaignStatus: "VERIFIED", usAppToPersonUsecase: "CUSTOMER_CARE" }],
    });

    const result = await attachPhoneNumberToBusinessMessagingRegistration({
      client: twilio.client,
      business: business(),
      phoneNumberSid: "PN22222222222222222222222222222222",
    });

    expect(twilio.phoneNumberCreate).toHaveBeenCalledWith({
      phoneNumberSid: "PN22222222222222222222222222222222",
    });
    expect(result.senderAttached).toBe(true);
    // Sender-pool membership is not carrier registration. Event Streams owns
    // the transition to SMS-ready.
    expect(result.smsReady).toBe(false);
  });

  test("is idempotent when the PN sender is already attached", async () => {
    const twilio = makeClient({
      senders: [{ phoneNumberSid: "PN22222222222222222222222222222222" }],
      campaigns: [{ campaignStatus: "VERIFIED", usAppToPersonUsecase: "CUSTOMER_CARE" }],
    });

    const result = await attachPhoneNumberToBusinessMessagingRegistration({
      client: twilio.client,
      business: business(),
      phoneNumberSid: "PN22222222222222222222222222222222",
    });

    expect(twilio.phoneNumberCreate).not.toHaveBeenCalled();
    expect(result.senderAttached).toBe(true);
    expect(result.lastError).toBe("");
  });

  test("refuses a second sender on a Sole Proprietor Campaign", async () => {
    const twilio = makeClient({
      senders: [{ phoneNumberSid: "PNAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
      campaigns: [{ campaignStatus: "VERIFIED", usAppToPersonUsecase: "SOLE_PROPRIETOR" }],
    });

    const result = await attachPhoneNumberToBusinessMessagingRegistration({
      client: twilio.client,
      business: business(),
      phoneNumberSid: "PNBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });

    expect(twilio.phoneNumberCreate).not.toHaveBeenCalled();
    expect(result.smsReady).toBe(false);
    expect(result.lastError).toContain("SOLE_PROPRIETOR_NUMBER_LIMIT");
  });

  test("keeps the number assigned for voice when sender association fails", async () => {
    const twilio = makeClient({
      createError: Object.assign(new Error("Twilio sender attach failed"), { code: 30034 }),
    });

    const result = await attachPhoneNumberToBusinessMessagingRegistration({
      client: twilio.client,
      business: business(),
      phoneNumberSid: "PN22222222222222222222222222222222",
    });

    expect(result.a2pStatus).toBe("failed");
    expect(result.smsReady).toBe(false);
    expect(result.lastError).toContain("30034");
  });
});
