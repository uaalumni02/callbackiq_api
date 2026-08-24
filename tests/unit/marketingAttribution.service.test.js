import Business from "../../src/models/business.js";
import CallLog from "../../src/models/callLog.js";
import Conversation from "../../src/models/conversation.js";
import Lead from "../../src/models/lead.js";
import MarketingSource from "../../src/models/marketingSource.js";
import TrackingNumber from "../../src/models/trackingNumber.js";
import { normalizePhoneToE164 } from "../../src/voice/voicePhone.service.js";

import {
  buildAttributionSnapshot,
  getLatestCallAttribution,
  resolveTrackingNumberContext,
  syncLatestAttribution,
} from "../../src/services/marketingAttribution.service.js";

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: { findById: jest.fn() },
}));

jest.mock("../../src/models/callLog.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../../src/models/conversation.js", () => ({
  __esModule: true,
  default: { updateOne: jest.fn() },
}));

jest.mock("../../src/models/lead.js", () => ({
  __esModule: true,
  default: { updateOne: jest.fn() },
}));

jest.mock("../../src/models/marketingSource.js", () => ({
  __esModule: true,
  MARKETING_SOURCE_CHANNELS: [
    "google_ads",
    "google_lsa",
    "google_business_profile",
    "other",
  ],
  default: { findById: jest.fn() },
}));

jest.mock("../../src/models/trackingNumber.js", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));

jest.mock("../../src/voice/voicePhone.service.js", () => ({
  __esModule: true,
  normalizePhoneToE164: jest.fn(),
}));

const query = (value) => ({
  lean: jest.fn().mockResolvedValue(value),
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
});

describe("MarketingAttributionService", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    normalizePhoneToE164.mockImplementation((phone) => {
      if (!phone || phone === "invalid") return "";
      return String(phone).startsWith("+")
        ? String(phone)
        : "+14045550100";
    });

    Lead.updateOne.mockResolvedValue({ acknowledged: true });
    Conversation.updateOne.mockResolvedValue({ acknowledged: true });
  });

  test("builds attribution snapshot", () => {
    expect(
      buildAttributionSnapshot({
        marketingSource: {
          _id: "source-1",
          name: "Google Ads",
          channel: "google_ads",
          campaign: "Emergency Plumbing",
        },
        trackingNumber: {
          _id: "number-1",
          phoneNumber: "+14045550123",
        },
      }),
    ).toEqual({
      sourceId: "source-1",
      sourceName: "Google Ads",
      channel: "google_ads",
      campaign: "Emergency Plumbing",
      trackingNumberId: "number-1",
      trackingNumber: "+14045550123",
    });
  });

  test("builds empty snapshot", () => {
    expect(buildAttributionSnapshot()).toEqual({
      sourceId: "",
      sourceName: "",
      channel: "",
      campaign: "",
      trackingNumberId: "",
      trackingNumber: "",
    });
  });

  test("returns null for invalid phone", async () => {
    await expect(resolveTrackingNumberContext("invalid")).resolves.toBeNull();
    expect(TrackingNumber.findOne).not.toHaveBeenCalled();
  });

  test("returns null when tracking number does not exist", async () => {
    TrackingNumber.findOne.mockReturnValue(query(null));

    await expect(
      resolveTrackingNumberContext("+14045550123"),
    ).resolves.toBeNull();
  });

  test("resolves tracking number, business, source and attribution", async () => {
    TrackingNumber.findOne.mockReturnValue(
      query({
        _id: "number-1",
        business: "business-1",
        marketingSource: "source-1",
        phoneNumber: "+14045550123",
        isPrimary: false,
      }),
    );

    Business.findById.mockReturnValue(
      query({
        _id: "business-1",
        isActive: true,
      }),
    );

    MarketingSource.findById.mockReturnValue(
      query({
        _id: "source-1",
        name: "Google Ads",
        channel: "google_ads",
        campaign: "Drain",
      }),
    );

    const result =
      await resolveTrackingNumberContext("+14045550123");

    expect(result.business._id).toBe("business-1");
    expect(result.marketingSource.name).toBe("Google Ads");
    expect(result.attribution.sourceName).toBe("Google Ads");
  });

  test("rejects inactive business", async () => {
    TrackingNumber.findOne.mockReturnValue(
      query({
        business: "business-1",
        marketingSource: null,
        phoneNumber: "+14045550123",
        isPrimary: false,
      }),
    );

    Business.findById.mockReturnValue(
      query({
        _id: "business-1",
        isActive: false,
      }),
    );

    await expect(
      resolveTrackingNumberContext("+14045550123"),
    ).resolves.toBeNull();
  });

  test("rejects inactive primary tracking number", async () => {
    TrackingNumber.findOne.mockReturnValue(
      query({
        business: "business-1",
        marketingSource: null,
        phoneNumber: "+14045550123",
        isPrimary: true,
      }),
    );

    Business.findById.mockReturnValue(
      query({
        _id: "business-1",
        isActive: true,
        trackingNumber: { status: "pending" },
      }),
    );

    await expect(
      resolveTrackingNumberContext("+14045550123"),
    ).resolves.toBeNull();
  });

  test("allows inactiveOnly lookup when activeOnly is false", async () => {
    TrackingNumber.findOne.mockReturnValue(
      query({
        _id: "number-1",
        business: "business-1",
        marketingSource: null,
        phoneNumber: "+14045550123",
        isPrimary: true,
      }),
    );

    Business.findById.mockReturnValue(
      query({
        _id: "business-1",
        isActive: true,
        trackingNumber: { status: "pending" },
      }),
    );

    const result = await resolveTrackingNumberContext(
      "+14045550123",
      { activeOnly: false },
    );

    expect(result.business._id).toBe("business-1");
  });

  test("syncs attribution to lead and conversation", async () => {
    const result = await syncLatestAttribution({
      businessId: "business-1",
      leadId: "lead-1",
      conversationId: "conversation-1",
      marketingSource: {
        _id: "source-1",
        name: "Google LSA",
        channel: "google_lsa",
      },
      trackingNumber: {
        _id: "number-1",
        phoneNumber: "+14045550123",
      },
    });

    expect(result.sourceName).toBe("Google LSA");

    expect(Lead.updateOne).toHaveBeenCalled();
    expect(Conversation.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      {
        $set: expect.objectContaining({
          replyFromPhone: "+14045550123",
          latestMarketingSource: "source-1",
        }),
      },
    );
  });

  test("uses called phone as reply number", async () => {
    await syncLatestAttribution({
      businessId: "business-1",
      conversationId: "conversation-1",
      calledPhone: "(404) 555-0100",
    });

    expect(Conversation.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      {
        $set: expect.objectContaining({
          replyFromPhone: "+14045550100",
        }),
      },
    );
  });

  test("supports sync without lead or conversation", async () => {
    const result = await syncLatestAttribution({
      businessId: "business-1",
      marketingSource: {
        _id: "source-1",
        name: "Referral",
        channel: "other",
      },
    });

    expect(result.sourceName).toBe("Referral");
    expect(Lead.updateOne).not.toHaveBeenCalled();
    expect(Conversation.updateOne).not.toHaveBeenCalled();
  });

  test("gets latest attribution by lead", async () => {
    CallLog.findOne.mockReturnValue(
      query({
        marketingSource: "source-1",
        trackingNumber: "number-1",
        attribution: { sourceName: "Google Ads" },
      }),
    );

    const result = await getLatestCallAttribution({
      businessId: "business-1",
      leadId: "lead-1",
    });

    expect(result.marketingSource).toBe("source-1");
    expect(result.attribution.sourceName).toBe("Google Ads");
  });

  test("gets latest attribution by phone", async () => {
    CallLog.findOne.mockReturnValue(
      query({
        marketingSource: "source-2",
        trackingNumber: null,
        attribution: {},
      }),
    );

    const result = await getLatestCallAttribution({
      businessId: "business-1",
      customerPhone: "(404) 555-0100",
    });

    expect(result.marketingSource).toBe("source-2");
  });

  test("returns null for invalid phone or no matching call", async () => {
    await expect(
      getLatestCallAttribution({
        businessId: "business-1",
        customerPhone: "invalid",
      }),
    ).resolves.toBeNull();

    CallLog.findOne.mockReturnValue(query(null));

    await expect(
      getLatestCallAttribution({
        businessId: "business-1",
        leadId: "lead-1",
      }),
    ).resolves.toBeNull();
  });
});
