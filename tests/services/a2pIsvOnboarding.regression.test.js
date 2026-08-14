import fs from "fs";
import path from "path";

const root = path.resolve(process.cwd());
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

describe("A2P ISV onboarding regression", () => {
  test("uses Twilio secondary-customer and A2P trust policies", () => {
    const source = read("src/services/a2pCustomerOnboarding.service.js");
    expect(source).toContain("RNdfbf3fae0e1107f8aded0e7cead80bf5");
    expect(source).toContain("RNb0d4771c2c98518d916a3d4cd70a8f8b");
    expect(source).toContain("customer_profile_business_information");
    expect(source).toContain("us_a2p_messaging_profile_information");
    expect(source).toContain("customerProfilesEntityAssignments.create");
    expect(source).toContain("trustProductsEntityAssignments.create");
  });

  test("creates one messaging service per customer and waits for Brand approval before Campaign", () => {
    const source = read("src/services/a2pCustomerOnboarding.service.js");
    expect(source).toContain("ensureMessagingService");
    expect(source).toContain("campaignReadyForCreation");
    expect(source).toContain('upper(registration.brandStatus) === "APPROVED"');
    expect(source).toContain("usAppToPerson.create");
    expect(source).toContain("privacyPolicyUrl");
    expect(source).toContain("termsAndConditionsUrl");
  });

  test("keeps SMS disabled until number-registration success", () => {
    const source = read("src/services/a2pCustomerOnboarding.service.js");
    expect(source).toContain('status === "REGISTERED"');
    expect(source).toContain('"messagingCompliance.smsReady": true');
    const attachSource = read("src/services/a2pMessagingRegistration.service.js");
    expect(attachSource).toContain("smsReady: false");
  });

  test("supports sole-proprietor OTP without exposing Twilio Console", () => {
    const source = read("src/services/a2pCustomerOnboarding.service.js");
    expect(source).toContain('brandType: "SOLE_PROPRIETOR"');
    expect(source).toContain("brandRegistrationOtps.create");
    expect(source).toContain('registration.status = "otp_required"');
  });

  test("event stream endpoint is authenticated", () => {
    const source = read("src/controllers/a2pEvents.controller.js");
    expect(source).toContain("timingSafeEqual");
    expect(source).toContain("A2P_EVENT_STREAM_USERNAME");
    expect(source).toContain("A2P_EVENT_STREAM_PASSWORD");
  });

  test("maps Event Streams phone-only payloads back to the owning business", () => {
    const source = read("src/services/a2pCustomerOnboarding.service.js");
    expect(source).toContain('"trackingNumber.providerSid": phoneNumberSid');
    expect(source).toContain("data.phonenumbersid");
    expect(source).toContain("data.messagingservicesid");
    expect(source).toContain("data.externalstatus");
  });

  test("configures stable A2P Event Stream schema versions", () => {
    const source = read("scripts/configure-a2p-event-stream.mjs");
    expect(source).toContain("schemaVersion: 1");
    expect(source).toContain('method: "POST"');
    expect(source).toContain("number-registration.successful");
  });
});
