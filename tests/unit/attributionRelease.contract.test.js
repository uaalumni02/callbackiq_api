import fs from "fs";
import path from "path";

const root = path.resolve(__dirname, "../..");
const source = (file) => fs.readFileSync(path.join(root, file), "utf8");

describe("Attribution release API contract", () => {
  test("report and forward-first callback routes are wired", () => {
    const attributionRoutes = source("src/routes/marketingAttribution.routes.js");
    const twilioRoutes = source("src/routes/twilio.routes.js");

    expect(attributionRoutes).toContain(
      'router.get("/report", MarketingAttributionController.report);',
    );
    expect(twilioRoutes).toContain("TrackingVoiceController.initial");
    expect(twilioRoutes).toContain('"/tracking-call-complete"');
  });

  test("source tracking provisioning is independent from A2P and recovery", () => {
    const service = source("src/services/marketingSource.service.js");

    expect(service).not.toContain("await requirePaidPlan(businessId);");
    expect(service).not.toContain('"SMS_REGISTRATION_REQUIRED"');
    expect(service).toContain('callHandlingMode: "forward"');
    expect(service).toContain("smsEnabled: false");
    expect(service).toContain("smsRecoveryEnabled: false");
    expect(service).toContain("voiceAiEnabled: false");
  });

  test("marketing numbers default SMS off without changing primary defaults", () => {
    const model = source("src/models/trackingNumber.js");
    expect(model).toContain('this.kind === "marketing" ? false : true');
  });

  test("provider state and business disposition are separate", () => {
    const model = source("src/models/callLog.js");
    const controller = source("src/controllers/trackingVoice.controller.js");

    expect(model).toContain("providerStatus");
    expect(model).toContain("destinationCallSid");
    expect(model).toContain("disposition");
    expect(model).toContain("answeredAt");
    expect(controller).toContain("answered_by_business");
  });

  test("immutable attribution evidence is retry-safe", () => {
    const service = source("src/services/marketingAttribution.service.js");
    expect(service).toContain("AttributionTouch.updateOne");
    expect(service).toContain("$setOnInsert");
    expect(service).toContain("callLogId");
  });
});
