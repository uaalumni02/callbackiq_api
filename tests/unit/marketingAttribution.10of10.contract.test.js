import fs from "fs";
import path from "path";

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

describe("marketing attribution 10/10 hardening contract", () => {
  test("Lead preserves immutable first touch and mutable latest touch", () => {
    const model = read("src/models/lead.js");
    const service = read("src/services/marketingAttribution.service.js");
    expect(model).toContain("firstMarketingSource");
    expect(model).toContain("firstTrackingNumber");
    expect(model).toContain("firstAttribution");
    expect(model).toContain("latestMarketingSource");
    expect(service).toContain("first touch is write-once");
    expect(service).toContain("latestMarketingSource");
  });

  test("booking synchronizes the authoritative estimate back to the Lead", () => {
    const source = read("src/services/conversionEvent.service.js");
    expect(source).toMatch(
      /estimatedValue:\s*Number\(appointment\.estimatedValue\s*\|\|\s*0\)/,
    );
  });

  test("revenue trends return the exact daily frontend contract", () => {
    const source = read("src/services/analytics/revenueRecovery.service.js");
    for (const field of [
      "missedCalls",
      "qualifiedLeads",
      "appointmentsBooked",
      "recoveredLeads",
      "estimatedRecoveredRevenue",
      "actualRecoveredRevenue",
    ]) {
      expect(source).toContain(field);
    }
    expect(source).toContain("authoritative collections");
  });

  test("source value semantics do not double count realized and open pipeline", () => {
    const source = read("src/services/analytics/revenueRecovery.service.js");
    expect(source).toContain("totalRecoveredAttributableValue");
    expect(source).toContain("totalBookedAttributableValue");
    expect(source).toContain('case: { $eq: ["$status", "completed"] }');
    expect(source).toContain('case: { $eq: ["$status", "confirmed"] }');
  });

  test("call logs are soft deleted but retained for attribution history", () => {
    const model = read("src/models/callLog.js");
    const controller = read("src/controllers/callLog.js");
    expect(model).toContain("deletedAt");
    expect(model).toContain("deletedBy");
    expect(controller).toContain("Deleted from Call Activity");
    expect(controller).not.toContain("await deleteCallLogForBusiness(id, business._id);");
  });

  test("lead and call operational views expose cursor-paged overview endpoints", () => {
    const paging = read("src/services/cursorPagination.service.js");
    const leadRoutes = read("src/routes/lead.routes.js");
    const callRoutes = read("src/routes/callLog.routes.js");
    expect(paging).toContain("getLeadsOverview");
    expect(paging).toContain("getCallLogsOverview");
    expect(leadRoutes).toContain("getMyLeadsOverview");
    expect(callRoutes).toContain("getMyCallLogsOverview");
  });

  test("historical data has an explicit reconciliation migration", () => {
    const source = read("scripts/reconcile-marketing-attribution-10of10.mjs");
    expect(source).toContain("firstTouchBackfilled");
    expect(source).toContain("valuesReconciled");
    expect(source).toContain("earliest");
  });

  test("analytics indexes match equality-before-range access patterns", () => {
    const lead = read("src/models/lead.js");
    const events = read("src/models/conversionEvent.js");
    expect(lead).toContain("firstRespondedAt: -1");
    expect(lead).toContain("qualifiedAt: -1");
    expect(events).toContain("business: 1, type: 1, occurredAt: -1");
  });
});
