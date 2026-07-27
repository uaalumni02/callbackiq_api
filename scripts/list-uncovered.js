#!/usr/bin/env node

/*
 * Reads Istanbul/V8 coverage-final.json and prints exact uncovered
 * statements, functions, and branch locations, ordered by file priority.
 */

import fs from "fs";
import path from "path";

const reportPath = path.resolve(
  process.argv[2] || "coverage/coverage-final.json",
);

if (!fs.existsSync(reportPath)) {
  console.error(`Coverage report not found: ${reportPath}`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

const lineFor = (location) =>
  location?.start?.line || location?.loc?.start?.line || null;

const rows = Object.entries(report).map(([file, data]) => {
  const uncoveredStatements = Object.entries(data.s || {})
    .filter(([, count]) => count === 0)
    .map(([id]) => lineFor(data.statementMap?.[id]))
    .filter(Boolean);

  const uncoveredFunctions = Object.entries(data.f || {})
    .filter(([, count]) => count === 0)
    .map(([id]) => ({
      name: data.fnMap?.[id]?.name || "anonymous",
      line: lineFor(data.fnMap?.[id]),
    }));

  const uncoveredBranches = [];
  Object.entries(data.b || {}).forEach(([id, counts]) => {
    counts.forEach((count, index) => {
      if (count !== 0) return;
      const branch = data.branchMap?.[id];
      const location = branch?.locations?.[index] || branch?.loc;
      uncoveredBranches.push({
        type: branch?.type || "branch",
        line: lineFor(location),
        path: index + 1,
      });
    });
  });

  return {
    file,
    uncoveredStatements,
    uncoveredFunctions,
    uncoveredBranches,
    total:
      uncoveredStatements.length +
      uncoveredFunctions.length +
      uncoveredBranches.length,
  };
});

rows
  .filter((row) => row.total > 0)
  .sort((a, b) => b.total - a.total)
  .forEach((row) => {
    console.log(`\n${row.file}`);
    console.log(`  Uncovered statements: ${row.uncoveredStatements.join(", ") || "none"}`);
    console.log(
      `  Uncovered functions: ${
        row.uncoveredFunctions
          .map((item) => `${item.name}@${item.line || "?"}`)
          .join(", ") || "none"
      }`,
    );
    console.log(
      `  Uncovered branches: ${
        row.uncoveredBranches
          .map((item) => `${item.type}@${item.line || "?"}#${item.path}`)
          .join(", ") || "none"
      }`,
    );
  });
