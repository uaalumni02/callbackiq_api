import fs from "node:fs";
import path from "node:path";
import {execFileSync} from 'node:child_process';
import {
  certificationStages,
  providerContractGroups,
} from "./productionJourney.manifest.js";

const root = process.cwd();
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

describe("MeekCall production certification structure", () => {
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

    const proof=execFileSync(process.execPath,['--input-type=module','-e',`
      import fs from 'node:fs';
      import {validatePlan} from './scripts/check.mjs';
      const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
      const plan=JSON.parse(fs.readFileSync('config/check-plan.json','utf8'));
      const aliases=JSON.parse(fs.readFileSync('config/legacy-check-aliases.json','utf8'));
      validatePlan(pkg.name,plan,aliases);
      const broken=structuredClone(plan);
      for(const gate of broken.gates) gate.steps=gate.steps.filter(step=>step!=='test:production-certification');
      let rejected=false;
      try{validatePlan(pkg.name,broken,aliases);}catch(error){rejected=error.message.includes('test:production-certification');}
      console.log(JSON.stringify({productionRequired:rejected}));
    `],{cwd:root,encoding:'utf8'});
    expect(JSON.parse(proof)).toEqual({productionRequired:true});
    expect(packageJson.scripts?.verify).toBe('node scripts/check.mjs');
  });
});
