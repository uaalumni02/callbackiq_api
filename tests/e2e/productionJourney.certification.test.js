import fs from "node:fs";
import path from "node:path";
import {
  certificationStages,
  providerContractGroups,
} from "./productionJourney.manifest.js";

const root = process.cwd();
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

describe("CallBackIQ production certification structure", () => {
  test("every customer-journey stage is backed by real regression suites", () => {
    expect(certificationStages.length).toBeGreaterThanOrEqual(10);

    for (const stage of certificationStages) {
      expect(stage.name).toBeTruthy();
      expect(stage.assertions.length).toBeGreaterThan(0);
      expect(stage.tests.length).toBeGreaterThan(0);

      for (const testFile of stage.tests) {
        expect({
          stage: stage.name,
          testFile,
          exists: exists(testFile),
        }).toMatchObject({ exists: true });
      }
    }
  });

  test("provider contract groups are backed by real test files", () => {
    expect(providerContractGroups.map((group) => group.name)).toEqual(
      expect.arrayContaining([
        "Twilio",
        "Stripe",
        "Google Calendar",
        "OpenAI",
      ]),
    );

    for (const group of providerContractGroups) {
      for (const testFile of group.tests) {
        expect({
          provider: group.name,
          testFile,
          exists: exists(testFile),
        }).toMatchObject({ exists: true });
      }
    }
  });

  test("certification never references live-provider or staging mutation suites", () => {
    const referenced = [
      ...certificationStages.flatMap((stage) => stage.tests),
      ...providerContractGroups.flatMap((group) => group.tests),
    ];

    for (const testFile of referenced) {
      expect(testFile).not.toMatch(
        /(?:^|[./_-])(live|production-live|staging-live)(?:[./_-]|$)/i,
      );
    }
  });

  test("Jest installs the provider network guard globally", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );

    expect(packageJson.jest?.setupFilesAfterEnv || []).toContain(
      "<rootDir>/tests/setup/externalProviderSafety.js",
    );
  });

  test("CI includes deterministic production certification", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );

    expect(packageJson.scripts?.["test:production-certification"]).toBeTruthy();
    expect(packageJson.scripts?.["test:ci"]).toContain(
      "test:production-certification",
    );
  });
});
