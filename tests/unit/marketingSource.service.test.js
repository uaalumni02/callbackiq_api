import Business from "../../src/models/business.js";
import MarketingSource from "../../src/models/marketingSource.js";
import Subscription from "../../src/models/subscription.js";
import TrackingNumber from "../../src/models/trackingNumber.js";
import { getTwilioClient } from "../../src/services/twilioSmsService.js";

import {
  createMarketingSource,
  listMarketingSources,
  updateMarketingSource,
  provisionMarketingTrackingNumber,
} from "../../src/services/marketingSource.service.js";

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));

jest.mock("../../src/models/marketingSource.js", () => ({
  __esModule: true,
  MARKETING_SOURCE_CHANNELS: [
    "google_ads",
    "google_lsa",
    "google_business_profile",
    "facebook",
    "other",
  ],
  default: {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
  },
}));

jest.mock("../../src/models/subscription.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../../src/models/trackingNumber.js", () => ({
  __esModule: true,
  default: {
    find: jest.fn(),
    findOne: jest.fn(),
    countDocuments: jest.fn(),
    exists: jest.fn(),
    create: jest.fn(),
  },
}));

jest.mock(
  "../../src/services/a2pMessagingRegistration.service.js",
  () => ({
    __esModule: true,
    attachPhoneNumberToBusinessMessagingRegistration: jest.fn(),
  }),
);

jest.mock("../../src/services/operationLease.service.js", () => ({
  __esModule: true,
  acquireOperationLease: jest.fn(),
  releaseOperationLease: jest.fn(),
}));

jest.mock("../../src/services/trialTelecomGuard.service.js", () => ({
  __esModule: true,
  assertAutomaticProvisioningBudget: jest.fn(),
  provisioningBudgetEnabled: jest.fn(),
}));

jest.mock("../../src/services/twilioSmsService.js", () => ({
  __esModule: true,
  getTwilioClient: jest.fn(),
}));

jest.mock("../../src/voice/voicePhone.service.js", () => ({
  __esModule: true,
  normalizePhoneToE164: jest.fn((value) => value),
}));

const chain = (value) => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

const selectPromise = (value) => ({
  select: jest.fn().mockResolvedValue(value),
});

describe("MarketingSourceService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ATTRIBUTION_INCLUDED_SOURCE_NUMBERS = "3";
    process.env.TWILIO_WEBHOOK_BASE_URL =
      "https://api.callbackiq.test";
  });

  test("lists sources and number limits", async () => {
    MarketingSource.find.mockReturnValue(
      chain([
        {
          _id: "source-1",
          name: "Google Ads",
          channel: "google_ads",
        },
      ]),
    );

    TrackingNumber.find.mockReturnValue(
      chain([
        {
          _id: "number-1",
          marketingSource: "source-1",
          status: "active",
        },
      ]),
    );

    Subscription.findOne.mockReturnValue(
      chain({
        isActive: true,
        status: "active",
      }),
    );

    Business.findById.mockReturnValue(
      selectPromise({}),
    );

    const result = await listMarketingSources({
      businessId: "business-1",
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].trackingNumbers).toHaveLength(1);
    expect(result.limits).toMatchObject({
      includedAdditionalNumbers: 3,
      activeAdditionalNumbers: 1,
      remainingAdditionalNumbers: 2,
      paidPlanActive: true,
    });
  });

  test("creates marketing source", async () => {
    MarketingSource.create.mockResolvedValue({
      _id: "source-1",
      name: "Google Ads",
    });

    const result = await createMarketingSource({
      businessId: "business-1",
      name: " Google Ads ",
      channel: "google_ads",
      campaign: " Emergency Plumbing ",
    });

    expect(result.name).toBe("Google Ads");

    expect(MarketingSource.create).toHaveBeenCalledWith({
      business: "business-1",
      name: "Google Ads",
      channel: "google_ads",
      campaign: "Emergency Plumbing",
    });
  });

  test("requires source name", async () => {
    await expect(
      createMarketingSource({
        businessId: "business-1",
        name: "",
        channel: "google_ads",
      }),
    ).rejects.toMatchObject({
      code: "MARKETING_SOURCE_NAME_REQUIRED",
    });
  });

  test("rejects invalid channel", async () => {
    await expect(
      createMarketingSource({
        businessId: "business-1",
        name: "Bad source",
        channel: "invalid",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_MARKETING_SOURCE_CHANNEL",
    });
  });

  test("maps duplicate source to conflict", async () => {
    MarketingSource.create.mockRejectedValue({
      code: 11000,
    });

    await expect(
      createMarketingSource({
        businessId: "business-1",
        name: "Google Ads",
        channel: "google_ads",
      }),
    ).rejects.toMatchObject({
      code: "MARKETING_SOURCE_ALREADY_EXISTS",
      statusCode: 409,
    });
  });

  test("updates source", async () => {
    MarketingSource.findOneAndUpdate.mockResolvedValue({
      _id: "source-1",
      name: "Google PPC",
      status: "paused",
    });

    const result = await updateMarketingSource({
      businessId: "business-1",
      sourceId: "source-1",
      updates: {
        name: " Google PPC ",
        campaign: " Summer ",
        channel: "google_ads",
        status: "paused",
      },
    });

    expect(result.name).toBe("Google PPC");
  });

  test("rejects invalid update channel", async () => {
    await expect(
      updateMarketingSource({
        businessId: "business-1",
        sourceId: "source-1",
        updates: {
          channel: "invalid",
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_MARKETING_SOURCE_CHANNEL",
    });
  });

  test("rejects invalid update status", async () => {
    await expect(
      updateMarketingSource({
        businessId: "business-1",
        sourceId: "source-1",
        updates: {
          status: "deleted",
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_MARKETING_SOURCE_STATUS",
    });
  });

  test("returns 404 for unknown source update", async () => {
    MarketingSource.findOneAndUpdate.mockResolvedValue(null);

    await expect(
      updateMarketingSource({
        businessId: "business-1",
        sourceId: "missing",
        updates: {
          status: "active",
        },
      }),
    ).rejects.toMatchObject({
      code: "MARKETING_SOURCE_NOT_FOUND",
      statusCode: 404,
    });
  });

  test("rejects provisioning for missing source", async () => {
    MarketingSource.findOne.mockResolvedValue(null);

    await expect(
      provisionMarketingTrackingNumber({
        businessId: "business-1",
        sourceId: "missing",
      }),
    ).rejects.toMatchObject({
      code: "MARKETING_SOURCE_NOT_FOUND",
    });
  });

  test("returns existing active tracking number", async () => {
    MarketingSource.findOne.mockResolvedValue({
      _id: "source-1",
      name: "Google Ads",
    });

    TrackingNumber.findOne.mockReturnValue(
      selectPromise({
        _id: "number-1",
        status: "active",
        phoneNumber: "+14045550123",
      }),
    );

    await expect(
      provisionMarketingTrackingNumber({
        businessId: "business-1",
        sourceId: "source-1",
      }),
    ).resolves.toMatchObject({
      _id: "number-1",
    });

    expect(Subscription.findOne).not.toHaveBeenCalled();
  });

  test("provisions attribution-only source number without paid plan or A2P", async () => {
    MarketingSource.findOne.mockResolvedValue({
      _id: "source-1",
      name: "Google Ads",
    });

    TrackingNumber.findOne.mockReturnValue(
      selectPromise(null),
    );
    TrackingNumber.countDocuments.mockResolvedValue(0);
    TrackingNumber.exists.mockResolvedValue(null);

    Business.findById.mockReturnValue(
      selectPromise({
        _id: "business-1",
        isActive: true,
        forwardingPhone: "+14045550100",
      }),
    );

    const listAvailableNumbers = jest
      .fn()
      .mockResolvedValue([
        { phoneNumber: "+14045550123" },
      ]);

    const createIncomingNumber = jest
      .fn()
      .mockResolvedValue({
        sid: "PN_MARKETING_1",
        phoneNumber: "+14045550123",
      });

    const incomingPhoneNumbers = jest.fn();
    incomingPhoneNumbers.create =
      createIncomingNumber;

    const availablePhoneNumbers = jest
      .fn()
      .mockReturnValue({
        local: {
          list: listAvailableNumbers,
        },
      });

    getTwilioClient.mockReturnValue({
      availablePhoneNumbers,
      incomingPhoneNumbers,
    });

    TrackingNumber.create.mockResolvedValue({
      _id: "number-1",
      business: "business-1",
      marketingSource: "source-1",
      phoneNumber: "+14045550123",
      kind: "marketing",
      callHandlingMode: "forward",
      voiceEnabled: true,
      smsEnabled: false,
      smsRecoveryEnabled: false,
      voiceAiEnabled: false,
      senderAttached: false,
      smsReady: false,
      status: "active",
    });

    const result =
      await provisionMarketingTrackingNumber({
        businessId: "business-1",
        sourceId: "source-1",
      });

    expect(result).toMatchObject({
      _id: "number-1",
      callHandlingMode: "forward",
      smsEnabled: false,
      smsRecoveryEnabled: false,
      voiceAiEnabled: false,
    });

    expect(Subscription.findOne).not.toHaveBeenCalled();

    expect(listAvailableNumbers).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceEnabled: true,
        limit: 1,
      }),
    );

    expect(
      listAvailableNumbers.mock.calls[0][0],
    ).not.toHaveProperty("smsEnabled");

    expect(TrackingNumber.create).toHaveBeenCalledWith(
      expect.objectContaining({
        business: "business-1",
        marketingSource: "source-1",
        kind: "marketing",
        callHandlingMode: "forward",
        forwardingPhone: "+14045550100",
        voiceEnabled: true,
        smsEnabled: false,
        smsRecoveryEnabled: false,
        voiceAiEnabled: false,
        recordingEnabled: false,
        senderAttached: false,
        smsReady: false,
      }),
    );
  });
});
