import {
  classifyInboundSmsCommand,
} from "../../src/services/messaging/contactPreference.service.js";

describe("Twilio opt-out ownership classification", () => {
  test.each(["STOP", "REVOKE", "OPTOUT"])(
    "treats %s as provider-managed opt-out",
    (keyword) => {
      expect(classifyInboundSmsCommand(keyword)).toMatchObject({
        handled: true,
        action: "opt_out",
        providerManaged: true,
        softOptOut: false,
      });
    },
  );

  test.each(["START", "UNSTOP", "YES"])(
    "treats %s as provider-managed opt-in",
    (keyword) => {
      expect(classifyInboundSmsCommand(keyword)).toMatchObject({
        handled: true,
        action: "opt_in",
        providerManaged: true,
      });
    },
  );

  test("does not assume Twilio auto-replied to punctuated STOP", () => {
    expect(classifyInboundSmsCommand("STOP.")).toMatchObject({
      handled: true,
      action: "opt_out",
      providerManaged: false,
      softOptOut: true,
    });
  });

  test("honors Twilio Advanced Opt-Out OptOutType", () => {
    expect(
      classifyInboundSmsCommand("anything", {
        twilioOptOutType: "STOP",
      }),
    ).toMatchObject({
      handled: true,
      action: "opt_out",
      providerManaged: true,
    });
  });

  test("retains natural-language soft opt-out handling in the app", () => {
    expect(
      classifyInboundSmsCommand("Please stop texting me"),
    ).toMatchObject({
      handled: true,
      action: "opt_out",
      providerManaged: false,
      softOptOut: true,
    });
  });

  test("does not opt out informational opt-out questions", () => {
    expect(
      classifyInboundSmsCommand("How do I opt out?"),
    ).toMatchObject({
      handled: false,
    });
  });
});
