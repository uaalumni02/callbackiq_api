
import mongoose from "mongoose";

import ContactPreference from "../../src/models/contactPreference.js";
import {
  getSmsPreference,
  isSmsSuppressed,
  isStartKeyword,
  optInSms,
  optOutSms,
  processInboundSmsCommand,
} from "../../src/services/messaging/contactPreference.service.js";
import {
  connectTestDB,
  clearTestDB,
  closeTestDB,
} from "../setup/testDb.js";

beforeAll(async () => {
  await connectTestDB();
  await ContactPreference.init();
  // Starting a real Mongo process and building indexes can exceed Jest's
  // five-second default on a cold run. Keep test-body timeouts unchanged.
}, 60000);

afterEach(async () => {
  await clearTestDB();
}, 30000);

afterAll(async () => {
  await closeTestDB();
}, 30000);

describe("contactPreference service", () => {
  test("normalizes a U.S. number and persists opt-out state", async () => {
    const businessId = new mongoose.Types.ObjectId();

    const preference = await optOutSms({
      businessId,
      phone: "(404) 555-0123",
      keyword: "stop",
    });

    expect(preference.phone).toBe("+14045550123");
    expect(preference.smsStatus).toBe("opted_out");
    expect(preference.optedOutAt).toBeTruthy();
    expect(preference.lastKeyword).toBe("STOP");

    await expect(
      isSmsSuppressed({
        businessId,
        phone: "404-555-0123",
      }),
    ).resolves.toBe(true);
  });

  test("reactivates an opted-out number", async () => {
    const businessId = new mongoose.Types.ObjectId();

    await optOutSms({
      businessId,
      phone: "4045550123",
    });

    const preference = await optInSms({
      businessId,
      phone: "+14045550123",
      keyword: "UNSTOP",
    });

    expect(preference.smsStatus).toBe("active");
    expect(preference.optedInAt).toBeTruthy();
    expect(preference.optedOutAt).toBeNull();
    expect(preference.lastKeyword).toBe("UNSTOP");

    await expect(
      isSmsSuppressed({
        businessId,
        phone: "4045550123",
      }),
    ).resolves.toBe(false);
  });

  test("returns null for a phone without a stored preference", async () => {
    const preference = await getSmsPreference({
      businessId: new mongoose.Types.ObjectId(),
      phone: "4045550123",
    });

    expect(preference).toBeNull();
  });

  test.each(["START", "start.", "UNSTOP", "unstop!"])(
    "%s is recognized as a start keyword",
    (keyword) => {
      expect(isStartKeyword(keyword)).toBe(true);
    },
  );

  test("processes STOP without invoking normal AI behavior", async () => {
    const businessId = new mongoose.Types.ObjectId();

    const result = await processInboundSmsCommand({
      businessId,
      phone: "4045550123",
      messageBody: "STOP",
    });

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        action: "opt_out",
        allowOptedOutReply: true,
      }),
    );

    expect(result.reply).toMatch(/unsubscribed/i);

    await expect(
      isSmsSuppressed({
        businessId,
        phone: "+14045550123",
      }),
    ).resolves.toBe(true);
  });

  test("processes START and reactivates SMS", async () => {
    const businessId = new mongoose.Types.ObjectId();

    await optOutSms({
      businessId,
      phone: "4045550123",
    });

    const result = await processInboundSmsCommand({
      businessId,
      phone: "4045550123",
      messageBody: "START",
    });

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        action: "opt_in",
        allowOptedOutReply: true,
      }),
    );

    expect(result.reply).toMatch(/resubscribed/i);

    await expect(
      isSmsSuppressed({
        businessId,
        phone: "4045550123",
      }),
    ).resolves.toBe(false);
  });

  test("processes HELP without changing the stored preference", async () => {
    const businessId = new mongoose.Types.ObjectId();

    const result = await processInboundSmsCommand({
      businessId,
      phone: "4045550123",
      messageBody: "HELP",
    });

    expect(result).toEqual(
      expect.objectContaining({
        handled: true,
        action: "help",
        allowOptedOutReply: true,
      }),
    );

    expect(result.reply).toMatch(/automated service assistant/i);

    const preference = await getSmsPreference({
      businessId,
      phone: "4045550123",
    });

    expect(preference).toBeNull();
  });

  test("returns an unhandled result for an ordinary service message", async () => {
    const result = await processInboundSmsCommand({
      businessId: new mongoose.Types.ObjectId(),
      phone: "4045550123",
      messageBody: "My drain is clogged",
    });

    expect(result).toEqual({
      handled: false,
      action: "",
      providerManaged: false,
      softOptOut: false,
      keyword: "MY DRAIN IS CLOGGED",
      optOutType: "",
      reply: "",
      allowOptedOutReply: false,
    });
  });
});
