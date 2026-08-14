import fs from "node:fs";
import path from "node:path";

import {
  attachPhoneNumberToBusinessMessagingRegistration,
  toMessagingComplianceUpdate,
} from "../../src/services/a2pMessagingRegistration.service.js";

const buildClient = ({ campaigns = [], senders = [], createError = null } = {}) => {
  const create = jest.fn(async () => {
    if (createError) throw createError;
    return { sid: "PNaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  });
  const phoneNumbers = {
    list: jest.fn(async () => senders),
    create,
  };
  const usAppToPerson = {
    list: jest.fn(async () => campaigns),
  };
  const service = { phoneNumbers, usAppToPerson };
  const services = jest.fn(() => service);

  return {
    client: { messaging: { v1: { services } } },
    services,
    phoneNumbers,
    usAppToPerson,
  };
};

const business = {
  messagingCompliance: {
    messagingServiceSid: "MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
};

const verifiedCampaign = {
  campaignStatus: "VERIFIED",
  usAppToPersonUsecase: "LOW_VOLUME_STANDARD",
};

describe("A2P tracking-number auto association regression", () => {
  test("adds a newly provisioned PN sender to the existing approved Messaging Service", async () => {
    const harness = buildClient({ campaigns: [verifiedCampaign], senders: [] });

    const result = await attachPhoneNumberToBusinessMessagingRegistration({
      client: harness.client,
      business,
      phoneNumberSid: "PNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(harness.services).toHaveBeenCalledWith(
      "MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(harness.phoneNumbers.create).toHaveBeenCalledWith({
      phoneNumberSid: "PNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(result).toMatchObject({
      a2pStatus: "pending",
      campaignStatus: "VERIFIED",
      smsReady: false,
      senderAttached: true,
      lastError: "",
    });
  });

  test("is idempotent when the PN sender is already in the Sender Pool", async () => {
    const harness = buildClient({
      campaigns: [verifiedCampaign],
      senders: [{ phoneNumberSid: "PNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }],
    });

    const result = await attachPhoneNumberToBusinessMessagingRegistration({
      client: harness.client,
      business,
      phoneNumberSid: "PNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(harness.phoneNumbers.create).not.toHaveBeenCalled();
    // Sender Pool membership is idempotent, but carrier registration can still
    // be pending. Twilio Event Streams owns the transition to smsReady=true.
    expect(result.a2pStatus).toBe("pending");
    expect(result.smsReady).toBe(false);
    expect(result.senderAttached).toBe(true);
  });

  test("does not attach a second sender to a Sole Proprietor campaign", async () => {
    const harness = buildClient({
      campaigns: [
        {
          campaignStatus: "VERIFIED",
          usAppToPersonUsecase: "SOLE_PROPRIETOR",
        },
      ],
      senders: [{ phoneNumberSid: "PNcccccccccccccccccccccccccccccccc" }],
    });

    const result = await attachPhoneNumberToBusinessMessagingRegistration({
      client: harness.client,
      business,
      phoneNumberSid: "PNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(harness.phoneNumbers.create).not.toHaveBeenCalled();
    expect(result.a2pStatus).toBe("failed");
    expect(result.smsReady).toBe(false);
    expect(result.lastError).toContain("SOLE_PROPRIETOR_NUMBER_LIMIT");
  });

  test("keeps A2P failure state separate from tracking-number/voice provisioning", async () => {
    const harness = buildClient({
      campaigns: [verifiedCampaign],
      senders: [],
      createError: Object.assign(new Error("Twilio sender association failed"), {
        code: 21610,
      }),
    });

    const result = await attachPhoneNumberToBusinessMessagingRegistration({
      client: harness.client,
      business,
      phoneNumberSid: "PNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(result.a2pStatus).toBe("failed");
    expect(result.smsReady).toBe(false);
    expect(result.lastError).toContain("Twilio sender association failed");
  });

  test("persists only public readiness fields while the MG SID remains a hidden model field", () => {
    const update = toMessagingComplianceUpdate({
      a2pStatus: "registered",
      campaignStatus: "VERIFIED",
      smsReady: true,
      senderAttached: true,
      lastCheckedAt: new Date("2026-08-13T00:00:00Z"),
    });

    expect(update["messagingCompliance.smsReady"]).toBe(true);
    expect(update["messagingCompliance.a2pStatus"]).toBe("registered");
    expect(update).not.toHaveProperty("messagingCompliance.messagingServiceSid");

    const model = fs.readFileSync(
      path.join(process.cwd(), "src/models/business.js"),
      "utf8",
    );
    expect(model).toContain("messagingServiceSid");
    expect(model).toContain("select: false");
  });

  test("tracking-number purchase calls the A2P association without changing billing/trial code", () => {
    const provisioning = fs.readFileSync(
      path.join(process.cwd(), "src/services/trackingNumberProvisioning.service.js"),
      "utf8",
    );
    expect(provisioning).toContain("attachPhoneNumberToBusinessMessagingRegistration");
    expect(provisioning).toContain("phoneNumberSid: incoming.sid");
    expect(provisioning).toContain("...toMessagingComplianceUpdate(a2pState)");
  });
});
