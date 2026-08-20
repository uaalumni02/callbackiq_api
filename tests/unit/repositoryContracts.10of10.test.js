import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const file = (relative) =>
  fs.readFileSync(path.join(root, relative), "utf8");

describe("10/10 repository contract guards", () => {
  test("appointment GET no longer performs expired-hold writes", () => {
    const source = file("src/controllers/appointment.js");
    const listBody =
      source.split("static async list")[1]?.split("static async get")[0] || "";
    expect(listBody).not.toContain("releaseExpiredHolds");
  });

  test("orphan release cross-checks both provider SID and phone", () => {
    const source = file("scripts/reconcile-twilio-number-inventory.mjs");
    expect(source).toContain("ownedSids.has");
    expect(source).toContain("ownedPhones.has");
    expect(source).toContain("TWILIO_ORPHAN_RELEASE_CONFIRMATION");
    expect(source).toContain("recentActivity");
  });

  test("demo /book route is registered once", () => {
    const source = file("src/routes/demoRequest.routes.js");
    expect((source.match(/router\.post\(\s*[\n\r ]*"\/book"/g) || []).length).toBe(1);
  });

  test("dashboard pipeline counters are aggregated in Mongo", () => {
    const source = file("src/services/ownerExperience.service.js");
    expect(source).toContain("pipelineRows");
    expect(source).toContain("Conversation.aggregate");
    expect(source).not.toContain("activeConversations.reduce");
  });

  test("interventions are priority-sorted before limit", () => {
    const source = file("src/controllers/intervention.js");
    const aggregate = source.indexOf("Alert.aggregate");
    const sort = source.indexOf("$sort", aggregate);
    const limit = source.indexOf("$limit", aggregate);
    expect(aggregate).toBeGreaterThan(-1);
    expect(sort).toBeGreaterThan(aggregate);
    expect(limit).toBeGreaterThan(sort);
  });
});
