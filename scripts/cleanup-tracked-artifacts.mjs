#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const root = process.cwd();
const apply = process.argv.includes("--apply");

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const message = result.stderr || result.stdout || `${command} exited ${result.status}`;
    throw new Error(String(message).trim());
  }
  return result.stdout;
};

let raw;
try {
  raw = run("git", ["ls-files", "-ci", "--exclude-standard", "-z"]);
} catch (error) {
  console.error(`REPOSITORY CLEANUP FAIL: ${error.message}`);
  process.exit(1);
}

const files = raw.split("\0").filter(Boolean).sort();
if (!files.length) {
  console.log("No tracked files are currently ignored by .gitignore.");
  process.exit(0);
}

console.log(`${files.length} tracked file(s) are ignored by .gitignore:`);
for (const file of files) console.log(`  - ${file}`);

if (!apply) {
  console.log(
    "\nDry run only. Re-run with --apply to remove these paths from the Git index while keeping the working-tree copies.",
  );
  process.exit(0);
}

// Chunk the argv list so large checked-in coverage directories do not exceed
// operating-system argument limits. git rm --cached leaves local files intact.
const chunkSize = 100;
for (let index = 0; index < files.length; index += chunkSize) {
  const chunk = files.slice(index, index + chunkSize);
  try {
    run("git", ["rm", "-r", "--cached", "--ignore-unmatch", "--", ...chunk], {
      stdio: "inherit",
    });
  } catch (error) {
    console.error(`REPOSITORY CLEANUP FAIL: ${error.message}`);
    process.exit(1);
  }
}

console.log(
  "\nTracked ignored artifacts were removed from the Git index. Review `git status`; local working-tree files were not deleted.",
);
