import fs from "fs";
import path from "path";

const root = process.cwd();
const source = (relative) =>
  fs.readFileSync(path.join(root, relative), "utf8");

describe("marketing attribution production hardening", () => {
  test("voice webhook resolves any owned Twilio number through the shared resolver", () => {
    const text = source("src/controllers/voiceWebhook.js");
    expect(text).toContain("resolveTwilioNumberContext");
    expect(text).toContain("numberContext?.business || null");
  });

  test("ConversationRelay call logs preserve tracking attribution", () => {
    const text = source("src/voice/voiceSession.service.js");
    expect(text).toContain("resolveTrackingNumberContext(normalizedTo)");
    expect(text).toContain("marketingSource: numberContext?.marketingSource?._id || null");
    expect(text).toContain("trackingNumber: numberContext?.trackingNumber?._id || null");
    expect(text).toContain("syncLatestAttribution");
  });

  test("appointment attribution normalizes customer phone and completed revenue carries attribution", () => {
    const text = source("src/services/scheduling/appointment.service.js");
    expect(text).toContain("normalizePhoneToE164(input.customerPhone)");
    const projection = source("src/services/scheduling/appointmentProjection.service.js");
    expect(projection).toContain("marketingSourceId: appointment.marketingSource || null");
    expect(projection).toContain("trackingNumberId: appointment.trackingNumber || null");
    expect(projection).toContain("attribution: appointment.attribution || {}");
  });

  test("marketing source API exposes provisioning blockers and release lifecycle", () => {
    const service = source("src/services/marketingSource.service.js");
    const routes = source("src/routes/marketingAttribution.routes.js");
    expect(service).toContain("primaryNumberActive");
    expect(service).toContain("smsRegistered");
    expect(service).toContain("releaseMarketingTrackingNumber");
    expect(service).toContain("archiveMarketingSource");
    expect(routes).toContain('router.delete("/:id/tracking-number"');
    expect(routes).toContain('router.delete("/:id"');
  });
});
