import {
  buildVerifiedFactUpdate,
  getBusinessFactsReadiness,
  getVerifiedBusinessFacts,
} from "../../src/services/businessFacts.service.js";

describe("Verified business facts", () => {
  test("includes only facts explicitly marked verified", () => {
    const business = {
      aiKnowledge: {
        verifiedFacts: {
          approvedServices: {
            value: ["Plumbing repair"],
            verified: true,
          },
          serviceAreas: {
            value: ["Atlanta"],
            verified: false,
          },
        },
      },
    };

    expect(getVerifiedBusinessFacts(business)).toEqual({
      approvedServices: ["Plumbing repair"],
    });
  });

  test("stamps verified facts with owner and time", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");

    const update = buildVerifiedFactUpdate({
      facts: {
        emergencyServiceAvailable: {
          value: false,
          verified: true,
        },
      },
      actorId: "507f1f77bcf86cd799439011",
      now,
    });

    expect(
      update["aiKnowledge.verifiedFacts.emergencyServiceAvailable"],
    ).toMatchObject({
      value: false,
      verified: true,
      verifiedAt: now,
      verifiedBy: "507f1f77bcf86cd799439011",
    });
  });

  test("reports missing facts instead of inventing them", () => {
    const result = getBusinessFactsReadiness({
      aiKnowledge: { verifiedFacts: {} },
    });

    expect(result.ready).toBe(false);
    expect(result.missingRequiredFacts).toContain("businessHours");
    expect(result.missingRequiredFacts).toContain("pricing");
  });
});
