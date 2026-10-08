jest.mock("twilio", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../../src/models/business.js", () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
    findOne: jest.fn(),
  },
}));

jest.mock("../../src/models/trackingNumber.js", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
  },
}));

jest.mock("../../src/services/messaging/contactPreference.service.js", () => ({
  __esModule: true,
  isSmsSuppressed: jest.fn(),
}));

jest.mock("../../src/services/communicationUsageReservation.service.js", () => ({
  __esModule: true,
  reserveCommunicationUsageOperation: jest.fn(),
  commitCommunicationUsageReservation: jest.fn(),
  markCommunicationProviderDispatch: jest.fn().mockResolvedValue({}),
  findCommunicationOperation: jest.fn(),
  isUncertainProviderFailure: jest.fn(),
  markCommunicationUsageUncertain: jest.fn(),
  releaseCommunicationUsageReservation: jest.fn(),
}));

jest.mock("../../src/services/smsContactDisclosure.service.js", () => ({
  __esModule: true,
  claimSmsContactDisclosure: jest.fn(),
  commitSmsContactDisclosure: jest.fn(),
  releaseSmsContactDisclosure: jest.fn(),
}));

jest.mock("../../src/services/outboundSmsAudit.service.js", () => ({
  __esModule: true,
  recordOutboundSmsAudit: jest.fn(),
}));

import twilio from "twilio";
import Business from "../../src/models/business.js";
import TrackingNumber from "../../src/models/trackingNumber.js";
import { isSmsSuppressed } from "../../src/services/messaging/contactPreference.service.js";
import {
  reserveCommunicationUsageOperation,
  commitCommunicationUsageReservation,
  markCommunicationProviderDispatch,
  markCommunicationUsageUncertain,
  findCommunicationOperation,
  isUncertainProviderFailure,
  releaseCommunicationUsageReservation,
} from "../../src/services/communicationUsageReservation.service.js";
import {
  claimSmsContactDisclosure,
  commitSmsContactDisclosure,
  releaseSmsContactDisclosure,
} from "../../src/services/smsContactDisclosure.service.js";
import { recordOutboundSmsAudit } from "../../src/services/outboundSmsAudit.service.js";
import {
  resetTwilioClient,
  sendSms,
} from "../../src/services/twilioSmsService.js";

const mockMessagesCreate = jest.fn();

const usageReservation = {
  _id: "usage-reservation-1",
  amount: 1,
  state: "pending",
};
const disclosureClaim = { _id: "disclosure-claim-1" };

describe("central outbound SMS policy", () => {
  afterEach(() => jest.useRealTimers());
  const business = {
    _id: "64f000000000000000000001",
    phone: "+14045550100",
    isActive: true,
  };

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    jest.setSystemTime(new Date("2026-09-23T16:00:00Z"));
    jest.clearAllMocks();
    resetTwilioClient();
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "test_token";

    twilio.mockReturnValue({
      messages: { create: mockMessagesCreate },
    });
    Business.findById.mockResolvedValue(business);
    Business.findOne.mockResolvedValue(business);
    TrackingNumber.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    });
    isSmsSuppressed.mockResolvedValue(false);
    findCommunicationOperation.mockResolvedValue(null);
    isUncertainProviderFailure.mockReturnValue(false);
    claimSmsContactDisclosure.mockResolvedValue({
      append: false,
      claim: disclosureClaim,
    });
    reserveCommunicationUsageOperation.mockResolvedValue({
      allowed: true,
      replayed: false,
      reservation: usageReservation,
      usage: {
        allowed: true,
        amount: 1,
        reservations: [],
      },
    });
    markCommunicationProviderDispatch.mockResolvedValue(usageReservation);
    markCommunicationUsageUncertain.mockResolvedValue({ state: "uncertain" });
    commitCommunicationUsageReservation.mockResolvedValue(usageReservation);
    commitSmsContactDisclosure.mockResolvedValue(disclosureClaim);
    releaseCommunicationUsageReservation.mockResolvedValue(usageReservation);
    releaseSmsContactDisclosure.mockResolvedValue(disclosureClaim);
    recordOutboundSmsAudit.mockResolvedValue({ _id: "audit-1" });
    mockMessagesCreate.mockResolvedValue({
      sid: "SM123",
      status: "queued",
      to: "+14045550101",
      from: business.phone,
    });
  });

  afterAll(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });

  test("rejects a sender number not assigned to the business", async () => {
    await expect(
      sendSms({
        businessId: business._id,
        to: "+14045550101",
        from: "+14045550999",
        body: "Hello",
      }),
    ).rejects.toMatchObject({ code: "SMS_SENDER_NOT_OWNED" });

    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(claimSmsContactDisclosure).not.toHaveBeenCalled();
    expect(reserveCommunicationUsageOperation).not.toHaveBeenCalled();
  });

  test("suppresses opted-out recipients before Twilio or usage reservation", async () => {
    isSmsSuppressed.mockResolvedValue(true);

    const result = await sendSms({
      businessId: business._id,
      to: "+14045550101",
      body: "Hello",
      actorId: "64f000000000000000000002",
      actorType: "user",
      source: "manual_sms",
    });

    expect(result).toMatchObject({
      suppressed: true,
      status: "suppressed",
      reason: "customer_opted_out",
    });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(reserveCommunicationUsageOperation).not.toHaveBeenCalled();
    expect(releaseSmsContactDisclosure).toHaveBeenCalledWith({
      claim: disclosureClaim,
    });
    expect(recordOutboundSmsAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: business._id,
        actorType: "user",
        source: "manual_sms",
        status: "suppressed",
      }),
    );
  });

  test("derives the sender from the business and records the acting user", async () => {
    const actorId = "64f000000000000000000002";

    const result = await sendSms({
      bypassQuietHours: true,
      businessId: business._id,
      to: "+14045550101",
      body: "Hello",
      actorId,
      actorType: "user",
      source: "manual_sms",
      usageCategory: "manual_sms",
    });

    expect(result).toMatchObject({ sid: "SM123", suppressed: false });
    expect(isSmsSuppressed).toHaveBeenCalledWith({
      businessId: business._id,
      phone: "+14045550101",
    });
    expect(reserveCommunicationUsageOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        business,
        customerPhone: "+14045550101",
        metric: "sms_outbound",
        bypass: false,
        amount: 1,
        source: "manual_sms",
      }),
    );
    expect(mockMessagesCreate).toHaveBeenCalledWith({
      to: "+14045550101",
      from: business.phone,
      body: "Hello",
    });
    expect(commitCommunicationUsageReservation).toHaveBeenCalledWith({
      reservation: usageReservation,
      providerOperationId: "SM123",
      providerStatus: "queued",
    });
    expect(commitSmsContactDisclosure).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: disclosureClaim,
        businessId: business._id,
        phone: "+14045550101",
        providerMessageId: "SM123",
      }),
    );
    expect(recordOutboundSmsAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: business._id,
        actorId,
        actorType: "user",
        from: business.phone,
        status: "sent",
        providerMessageId: "SM123",
      }),
    );
  });

  test("retains server-controlled Messaging Service delivery for automation", async () => {
    await sendSms({
      bypassQuietHours: true,
      business,
      to: "+14045550101",
      body: "Automated follow-up",
      actorType: "automation",
      source: "automation",
      messagingServiceSid: "MG123",
    });

    expect(mockMessagesCreate).toHaveBeenCalledWith({
      to: "+14045550101",
      body: "Automated follow-up",
      messagingServiceSid: "MG123",
    });
  });
  test("latest owner text choice wins over a queued business snapshot", async () => {
    Business.findById.mockResolvedValue({ ...business, customerMessaging: { automaticTextsEnabled: false } });
    const result = await sendSms({ business, to: "+14045550101", body: "Queued reminder", source: "appointment_reminder" });
    expect(result).toMatchObject({ suppressed: true, reason: "automatic_customer_texts_disabled" });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
    expect(releaseCommunicationUsageReservation).toHaveBeenCalled();
  });
  test("manually sent replies still work with automatic customer texts off", async () => {
    Business.findById.mockResolvedValue({ ...business, customerMessaging: { automaticTextsEnabled: false } });
    const result = await sendSms({ business, to: "+14045550101", body: "A personal reply", usageCategory: "manual_sms" });
    expect(result.suppressed).toBe(false);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
  });

  test('provider acceptance followed by a database failure never releases or resends', async () => {
    commitCommunicationUsageReservation.mockRejectedValueOnce(new Error('database write unavailable'));
    await expect(sendSms({ business, to: '+14045550101', body: 'Hello', bypassQuietHours: true }))
      .rejects.toMatchObject({ deliveryUncertain: true, providerAccepted: true, providerMessageId: 'SM123' });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    expect(releaseCommunicationUsageReservation).not.toHaveBeenCalled();
    expect(markCommunicationUsageUncertain).toHaveBeenCalledWith(expect.objectContaining({ providerOperationId: 'SM123' }));
    expect(markCommunicationProviderDispatch.mock.invocationCallOrder[0]).toBeLessThan(mockMessagesCreate.mock.invocationCallOrder[0]);
  });
  test('disclosure persistence failure after acceptance cannot make a send retryable', async () => {
    commitSmsContactDisclosure.mockRejectedValueOnce(new Error('disclosure persistence failed'));
    await expect(sendSms({ business, to: '+14045550101', body: 'Hello', bypassQuietHours: true }))
      .rejects.toMatchObject({ deliveryUncertain: true, providerAccepted: true });
    expect(releaseCommunicationUsageReservation).not.toHaveBeenCalled();
  });
  test.each(['pending', 'uncertain'])('a %s send retains uncertainty on replay', async state => {
    findCommunicationOperation.mockResolvedValue({ state });
    await expect(sendSms({ business, to: '+14045550101', body: 'Hello' }))
      .rejects.toMatchObject({ deliveryUncertain: true, code: 'SMS_DELIVERY_RECONCILIATION_REQUIRED' });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
  test('a lost dispatch reservation blocks the provider call', async () => {
    markCommunicationProviderDispatch.mockRejectedValueOnce(Object.assign(new Error('reservation lost'), { deliveryUncertain: true }));
    await expect(sendSms({ business, to: '+14045550101', body: 'Hello', bypassQuietHours: true })).rejects.toMatchObject({ deliveryUncertain: true });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
  test('a provider response without a receipt remains uncertain', async () => {
    mockMessagesCreate.mockResolvedValueOnce({ status: 'queued' });
    await expect(sendSms({ business, to: '+14045550101', body: 'Hello', bypassQuietHours: true })).rejects.toMatchObject({ deliveryUncertain: true });
    expect(releaseCommunicationUsageReservation).not.toHaveBeenCalled();
  });
  test('server errors after dispatch never release a possibly accepted send', async () => {
    mockMessagesCreate.mockRejectedValueOnce(Object.assign(new Error('upstream failure'), { status: 503 }));
    await expect(sendSms({ business, to: '+14045550101', body: 'Hello', bypassQuietHours: true })).rejects.toMatchObject({ deliveryUncertain: true });
    expect(releaseCommunicationUsageReservation).not.toHaveBeenCalled();
  });
  test('conclusive provider rejection permits retry with the same operation key', async () => {
    mockMessagesCreate.mockRejectedValueOnce(Object.assign(new Error('invalid sender'), { status: 400, code: 21612 }));
    await expect(sendSms({ business, to: '+14045550101', body: 'Hello', bypassQuietHours: true })).rejects.toMatchObject({ code: 21612 });
    expect(releaseCommunicationUsageReservation).toHaveBeenCalledWith(expect.objectContaining({ providerRejected: true }));
    expect(markCommunicationUsageUncertain).not.toHaveBeenCalled();
  });
  test('a recovered receipt returns the original provider payload without another text', async () => {
    findCommunicationOperation.mockResolvedValue({ state: 'uncertain', providerOperationId: 'SMold', providerStatus: 'queued',
      metadata: { providerRequest: { body: 'Original. Reply STOP to opt out.', from: '+14045550199', to: '+14045550101' } } });
    const result = await sendSms({ business, to: '+14045550101', body: 'Changed template' });
    expect(result).toMatchObject({ sid: 'SMold', body: 'Original. Reply STOP to opt out.', from: '+14045550199', replayed: true });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  test('status callback includes the durable reservation reference and retains provider retry overrides', async () => {
    const prior = process.env.TWILIO_SMS_STATUS_CALLBACK_URL;
    process.env.TWILIO_SMS_STATUS_CALLBACK_URL = 'https://api.callbackiq.com/api/twilio/status#rc=2&rp=ct,rt';
    try {
      await sendSms({ business, to: '+14045550101', body: 'Hello', bypassQuietHours: true });
      const callback = new URL(mockMessagesCreate.mock.calls[0][0].statusCallback);
      expect(callback.searchParams.get('smsReservationId')).toBe(usageReservation._id);
      expect(callback.pathname).toBe('/api/twilio/status');
      expect(callback.hash).toContain('rc=');
    } finally { if (prior === undefined) delete process.env.TWILIO_SMS_STATUS_CALLBACK_URL; else process.env.TWILIO_SMS_STATUS_CALLBACK_URL = prior; }
  });

});
