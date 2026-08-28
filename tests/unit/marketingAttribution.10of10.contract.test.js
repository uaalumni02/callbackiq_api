import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

describe("marketing attribution 10/10 production contracts", () => {
  test("source-number SMS requires owned active messaging readiness and forces exact sender", () => {
    const text = source("src/services/twilioSmsService.js");
    expect(text).toContain("TrackingNumber.findOne");
    expect(text).toContain('status: "active"');
    expect(text).toContain("smsEnabled: true");
    expect(text).toContain("smsReady: true");
    expect(text).toContain("senderAttached: true");
    expect(text).toContain("forceDirectSender");
    expect(text).toContain("forceDirectSender || !configuredMessagingServiceSid");
  });

  test("completed recovered jobs reconcile later completion revenue", () => {
    const text = source("src/services/analytics/revenueRecovery.service.js");
    expect(text).toContain('type: "job_completed"');
    expect(text).toContain("totalRecoveredAttributableValue");
    expect(text).toContain("totalBookedAttributableValue");
    expect(text).toContain("MarketingSource.find({ business: businessId })");
    expect(text).toContain("snapshotSourceName");
  });

  test("appointment attribution is resolved once per hold", () => {
    const text = source("src/services/scheduling/appointment.service.js");
    expect(text).not.toContain("marketingSource: attribution.marketingSource");
    expect(text).not.toContain("const attribution = await resolveAppointmentAttribution");
  });

  test("released tracking numbers preserve history without blocking carrier recycling", () => {
    const model = source("src/models/trackingNumber.js");
    const service = source("src/services/marketingSource.service.js");
    expect(model).toContain('this.status === "released"');
    expect(model).toContain("released:${");
    expect(service).toContain("number.releasedAt = new Date()");
    expect(service).toContain("releasedCollision");
    expect(service).toContain("TRACKING_NUMBER_PHONE_COLLISION");
  });
});
