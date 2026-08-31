import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

describe("trial lifecycle runtime wiring", () => {
  test("embedded all-role API starts and stops the trial lifecycle worker", () => {
    const source = read("src/server.js");

    expect(source).toContain(
      'from "./workers/trialLifecycle.worker.js"'
    );

    expect(source).toMatch(
      /shouldRunEmbeddedWorkers\(\)[\s\S]{0,160}startTrialLifecycleWorker\(\)/
    );

    expect(source).toContain(
      "stopTrialLifecycleWorker();"
    );
  });

  test("generic worker role includes trial lifecycle processing", () => {
    const source = read("src/worker.js");

    expect(source).toContain(
      'from "./workers/trialLifecycle.worker.js"'
    );

    expect(source).toMatch(
      /worker:\s*\[[\s\S]*?\["lifecycle",\s*startTrialLifecycleWorker,\s*stopTrialLifecycleWorker\]/
    );
  });

  test("dedicated worker-lifecycle role runs lifecycle rather than automation", () => {
    const source = read("src/worker.js");

    expect(source).toMatch(
      /"worker-lifecycle":\s*\[\s*\["lifecycle",\s*startTrialLifecycleWorker,\s*stopTrialLifecycleWorker\]\s*,?\s*\]/
    );

    const lifecycleRole =
      source.match(
        /"worker-lifecycle":\s*\[([\s\S]*?)\]\s*,/
      )?.[1] || "";

    expect(lifecycleRole).not.toContain(
      "startAutomationWorker"
    );
  });
});
