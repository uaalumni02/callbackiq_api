#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const coverageDir = path.join(process.cwd(), "coverage");
fs.rmSync(coverageDir, { recursive: true, force: true });
console.log("Removed previous coverage output; the next report will be generated from this revision only.");
