
import {
  buildTwilioEventIdentity,
  getTwilioStatusEventType,
} from "../../src/helpers/twilioEventKey.js";

describe("twilioEventKey helper", () => {
  test("builds an inbound SMS identity from MessageSid", () => {
    expect(
      buildTwilioEventIdentity("inbound_sms", {
        MessageSid: "SM_TEST_123",
      }),
    ).toEqual({
      eventType: "inbound_sms",
      providerEventId: "SM_TEST_123",
      eventKey: "inbound_sms:SM_TEST_123",
    });
  });

  test("uses SmsSid when MessageSid is unavailable", () => {
    expect(
      buildTwilioEventIdentity("inbound_sms", {
        SmsSid: "SM_SMS_SID_123",
      }),
    ).toEqual({
      eventType: "inbound_sms",
      providerEventId: "SM_SMS_SID_123",
      eventKey: "inbound_sms:SM_SMS_SID_123",
    });
  });

  test("builds an inbound voice identity from CallSid", () => {
    expect(
      buildTwilioEventIdentity("inbound_voice", {
        CallSid: "CA_TEST_123",
      }),
    ).toEqual({
      eventType: "inbound_voice",
      providerEventId: "CA_TEST_123",
      eventKey: "inbound_voice:CA_TEST_123",
    });
  });

  test("includes status and sequence in a voice status key", () => {
    expect(
      buildTwilioEventIdentity("voice_status", {
        CallSid: "CA_TEST_123",
        CallStatus: "completed",
        SequenceNumber: "4",
      }),
    ).toEqual({
      eventType: "voice_status",
      providerEventId: "CA_TEST_123",
      eventKey: "voice_status:CA_TEST_123:completed:4",
    });
  });

  test("includes the message status in a message status key", () => {
    expect(
      buildTwilioEventIdentity("message_status", {
        MessageSid: "SM_TEST_123",
        MessageStatus: "delivered",
      }),
    ).toEqual({
      eventType: "message_status",
      providerEventId: "SM_TEST_123",
      eventKey: "message_status:SM_TEST_123:delivered",
    });
  });

  test("selects message status when a message SID exists", () => {
    expect(
      getTwilioStatusEventType({
        MessageSid: "SM_TEST_123",
      }),
    ).toBe("message_status");

    expect(
      getTwilioStatusEventType({
        SmsSid: "SM_TEST_456",
      }),
    ).toBe("message_status");
  });

  test("selects voice status when no message SID exists", () => {
    expect(
      getTwilioStatusEventType({
        CallSid: "CA_TEST_123",
      }),
    ).toBe("voice_status");
  });

  test("uses a stable payload hash when a provider SID is missing", () => {
    const first = buildTwilioEventIdentity("inbound_sms", {
      From: "4045551111",
      To: "4045552222",
      Body: "Hello",
    });

    const second = buildTwilioEventIdentity("inbound_sms", {
      Body: "Hello",
      To: "4045552222",
      From: "4045551111",
    });

    expect(first.providerEventId).toBe(second.providerEventId);
    expect(first.eventKey).toBe(second.eventKey);
  });

  test("rejects unsupported event types", () => {
    expect(() =>
      buildTwilioEventIdentity("unsupported", {
        MessageSid: "SM_TEST_123",
      }),
    ).toThrow("Unsupported Twilio event type");
  });
});
