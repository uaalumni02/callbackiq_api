#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const strict = process.argv.includes("--strict");
const root = process.cwd();
const ignored = new Set(["node_modules", ".git"]);
const forbiddenNames = [/^\.env$/, /^\.env\.(?!example$)/, /^coverage$/, /^\.callbackiq-(?:backups|fix-backups|phase9-backup)$/];
const secretPatterns = [
  /TWILIO_AUTH_TOKEN\s*=\s*[^\s#]+/i,
  /OPENAI_API_KEY\s*=\s*[^\s#]+/i,
  /STRIPE_SECRET_KEY\s*=\s*[^\s#]+/i,
  /mongodb(?:\+srv)?:\/\/[^\s"']+/i,
];
const findings = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const relative = path.relative(root, file);
    if (forbiddenNames.some((pattern) => pattern.test(entry.name))) {
      findings.push({ type: "repository_artifact", path: relative });
      if (entry.isDirectory()) continue;
    }
    if (entry.isDirectory()) walk(file);
    else if (entry.size < 2_000_000 && /\.(?:js|jsx|mjs|cjs|json|md|txt|env)$/i.test(entry.name)) {
      const text = fs.readFileSync(file, "utf8");
      for (const pattern of secretPatterns) {
        if (pattern.test(text) && !/\.env\.example$/.test(relative)) {
          findings.push({ type: "possible_secret", path: relative, pattern: String(pattern) });
        }
      }
    }
  }
};
walk(root);
console.log(JSON.stringify({ clean: findings.length === 0, findings }, null, 2));
if (strict && findings.length) process.exitCode = 2;
