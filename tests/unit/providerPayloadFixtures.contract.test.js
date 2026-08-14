import fs from "node:fs";
import path from "node:path";

const fixtureRoot = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "providers",
);

const readJson = (...segments) =>
  JSON.parse(fs.readFileSync(path.join(fixtureRoot, ...segments), "utf8"));

const readForm = (...segments) =>
  new URLSearchParams(
    fs.readFileSync(path.join(fixtureRoot, ...segments), "utf8").trim(),
  );

describe("sanitized provider payload fixtures", () => {
  test.each([
    ["customer.subscription.deleted.json", "customer.subscription.deleted"],
    ["customer.subscription.paused.json", "customer.subscription.paused"],
    ["customer.subscription.resumed.json", "customer.subscription.resumed"],
    [
      "customer.subscription.trial_will_end.json",
      "customer.subscription.trial_will_end",
    ],
    ["invoice.paid.json", "invoice.paid"],
    ["invoice.payment_failed.json", "invoice.payment_failed"],
  ])("Stripe fixture %s preserves event identity and object shape", (file, type) => {
    const fixture = readJson("stripe", file);
    expect(fixture.id).toMatch(/^evt_/);
    expect(fixture.type).toBe(type);
    expect(fixture.data?.object?.id).toBeTruthy();
    expect(fixture.livemode).toBe(false);
  });

  test("Twilio inbound SMS fixture remains form-encoded and contains provider ids", () => {
    const fixture = readForm("twilio", "inbound-sms.form.txt");
    expect(fixture.get("From")).toMatch(/^\+1/);
    expect(fixture.get("To")).toMatch(/^\+1/);
    expect(fixture.get("MessageSid")).toMatch(/^SM/);
    expect(fixture.get("Body")).toBeTruthy();
  });

  test("Twilio missed-call fixture remains form-encoded", () => {
    const fixture = readForm("twilio", "missed-call.form.txt");
    expect(fixture.get("CallSid")).toMatch(/^CA/);
    expect(fixture.get("CallStatus")).toBe("no-answer");
  });

  test("A2P fixtures encode verified campaign and separate registration readiness", () => {
    const campaign = readJson("a2p", "campaign-verified.json");
    const registration = readJson("a2p", "number-registration-succeeded.json");

    expect(campaign.campaignStatus).toBe("VERIFIED");
    expect(campaign.usAppToPersonUsecase).toBe("LOW_VOLUME_STANDARD");
    expect(Array.isArray(registration)).toBe(true);
    expect(registration).toHaveLength(1);
    const event = registration[0];
    expect(event.specversion).toBe("1.0");
    expect(event.type).toBe(
      "com.twilio.messaging.compliance.number-registration.successful",
    );
    expect(event.datacontenttype).toBe("application/json");
    expect(event.data.phonenumbersid).toMatch(/^PN/);
    expect(event.data.messagingservicesid).toMatch(/^MG/);
    expect(event.data.campaignsid).toMatch(/^CM/);
    expect(event.data.externalstatus).toBe("registered");
  });
});
