import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const run = (command, args, options = {}) => {
  console.log();
  console.log(`> ${command} ${args.join(" ")}`);

  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `${command} exited with status ${result.status ?? 1}`,
    );
  }
};

const capture = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `${command} exited with status ${result.status ?? 1}\n${result.stderr || ""}`,
    );
  }

  return result.stdout;
};

const changedOutput = capture("git", [
  "diff",
  "--name-only",
  "--diff-filter=ACMR",
  "HEAD^",
  "--",
  "src",
]);

const changedSourceFiles = [
  ...new Set(
    changedOutput
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((file) =>
        /\.(?:js|mjs|cjs)$/.test(file),
      )
      .filter((file) =>
        fs.existsSync(path.join(root, file)),
      ),
  ),
];

if (!changedSourceFiles.length) {
  console.log(
    "No changed production JavaScript files relative to HEAD^.",
  );

  run(process.execPath, [
    "scripts/verify-diff-coverage.mjs",
  ]);

  process.exit(0);
}

console.log();
console.log("Changed production files:");

for (const file of changedSourceFiles) {
  console.log(`  - ${file}`);
}

const relatedResult = spawnSync(
  npx,
  [
    "jest",
    "--findRelatedTests",
    ...changedSourceFiles,
    "--listTests",
    "--runInBand",
  ],
  {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  },
);

if (relatedResult.error) {
  throw relatedResult.error;
}

if ((relatedResult.status ?? 1) !== 0) {
  process.stderr.write(
    relatedResult.stderr || "",
  );

  throw new Error(
    "Jest could not discover related tests.",
  );
}

const relatedTests = relatedResult.stdout
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean);

const explicitReleaseTests = [
  "tests/unit/scaleTimeoutControllers.release.test.js",
  "tests/unit/scaleCustomerDetail.release.test.js",
  "tests/unit/scaleCacheCoordinator.release.test.js",
  "tests/unit/scaleCacheRedis.release.test.js",
  "tests/unit/scaleReadContracts.release.test.js",
  "tests/unit/scaleCapacityPlan.release.test.js",
  "tests/unit/scaleHealth.release.test.js",

  "tests/unit/adminScaleHealth.route.release.test.js",
  "tests/unit/staffNotification.worker.release.test.js",
  "tests/unit/staffNotification.dispatch.test.js",
  "tests/unit/remainingCoverage.server.test.js",

  "tests/unit/aiBookingApproval.production.test.js",
  "tests/unit/aiBookingPermission.release.test.js",
  "tests/unit/aiBookingTools.test.js",
  "tests/unit/createAppointment.tool.test.js",
  "tests/unit/createAppointment.diffCoverage.release.test.js",
  "tests/unit/availability.service.test.js",
  "tests/unit/availabilityLeadTime.production.test.js",
  "tests/unit/availability.diffCoverage.release.test.js",
  "tests/unit/bookingStateMachine.productionScheduling.test.js",
  "tests/unit/bookingStateMachine.service.full.test.js",
  "tests/unit/voiceAgent.service.test.js",
  "tests/unit/voiceBookingStateMachineReuse.test.js",
  "tests/unit/voiceConversationExperience.regression.test.js",
  "tests/unit/releaseCoverageRatchet.topoff.test.js",
  "tests/unit/validateTwilioSignature.releaseRatchet.test.js",
]
  .filter((file) =>
    fs.existsSync(path.join(root, file)),
  )
  .map((file) =>
    path.resolve(root, file),
  );

const tests = [
  ...new Set([
    ...relatedTests.map((file) =>
      path.resolve(file),
    ),
    ...explicitReleaseTests,
  ]),
];

if (!tests.length) {
  throw new Error(
    "No related tests were discovered for changed production files.",
  );
}

console.log();
console.log(
  `Deterministic diff-coverage suite: ${tests.length} test files`,
);

const fullCoverage = path.join(
  root,
  "coverage",
);

const savedFullCoverage = path.join(
  root,
  "coverage-full-suite",
);

const diffCoverage = path.join(
  root,
  "coverage-diff-release",
);

fs.rmSync(savedFullCoverage, {
  recursive: true,
  force: true,
});

fs.rmSync(diffCoverage, {
  recursive: true,
  force: true,
});

let fullCoverageWasSaved = false;

if (fs.existsSync(fullCoverage)) {
  fs.renameSync(
    fullCoverage,
    savedFullCoverage,
  );

  fullCoverageWasSaved = true;
}

let verificationPassed = false;

try {
  const coverageArgs = [
    "jest",
    ...tests,
    "--runInBand",
    "--no-cache",
    "--coverage",
    "--coverageDirectory=coverage",
    "--coverageReporters=json",
    "--coverageReporters=lcov",
    "--coverageReporters=text-summary",
  ];

  for (const file of changedSourceFiles) {
    coverageArgs.push(
      `--collectCoverageFrom=${file}`,
    );
  }

  run(npx, coverageArgs);

  console.log();
  console.log(
    "Running the existing CallBackIQ diff verifier against deterministic coverage...",
  );

  run(process.execPath, [
    "scripts/verify-diff-coverage.mjs",
  ]);

  verificationPassed = true;
} finally {
  if (fs.existsSync(fullCoverage)) {
    fs.renameSync(
      fullCoverage,
      diffCoverage,
    );
  }

  if (
    fullCoverageWasSaved &&
    fs.existsSync(savedFullCoverage)
  ) {
    fs.renameSync(
      savedFullCoverage,
      fullCoverage,
    );
  }
}

if (!verificationPassed) {
  throw new Error(
    "Deterministic changed-code coverage gate failed.",
  );
}

console.log();
console.log(
  "Deterministic changed-code coverage gate passed.",
);

console.log(
  `Diff artifact preserved at ${diffCoverage}`,
);
