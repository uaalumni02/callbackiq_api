#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const strict = process.argv.includes("--strict");
const root = process.cwd();

const forbiddenPathPatterns = [
  /^\.env$/,
  /^\.env\.(?!example$)/,
  /^coverage(?:\/|$)/,
  /^\.callbackiq-(?:backups|fix-backups|phase9-backup)(?:\/|$)/,
  /^\.callbackiq-.*backup.*(?:\/|$)/,
];

const credentialPatterns = [
  {
    name: "TWILIO_AUTH_TOKEN",
    regex: /TWILIO_AUTH_TOKEN\s*=\s*["'`]?([^"'`\s#;,]+)/gi,
  },
  {
    name: "OPENAI_API_KEY",
    regex: /OPENAI_API_KEY\s*=\s*["'`]?([^"'`\s#;,]+)/gi,
  },
  {
    name: "STRIPE_SECRET_KEY",
    regex: /STRIPE_SECRET_KEY\s*=\s*["'`]?([^"'`\s#;,]+)/gi,
  },
];

const mongoPattern =
  /mongodb(?:\+srv)?:\/\/[^\s"'`#]+/gi;

const findings = [];

const normalizeValue = (value) =>
  String(value || "")
    .trim()
    .replace(/[;,]+$/, "")
    .toLowerCase();

const isObviousPlaceholder = (name, rawValue) => {
  const value = normalizeValue(rawValue);

  if (!value) return false;

  // Short values used explicitly as test fixtures.
  if (["token", "primary", "next"].includes(value)) {
    return true;
  }

  if (
    value === "..." ||
    value === "<token>" ||
    value === "<secret>" ||
    value === "<api-key>" ||
    value === "<api_key>"
  ) {
    return true;
  }

  if (
    /^(?:test|fake|mock|dummy|example|placeholder)(?:[-_].*)?$/.test(
      value,
    )
  ) {
    return true;
  }

  if (name === "TWILIO_AUTH_TOKEN") {
    return [
      "auth_test",
      "auth-test",
      "test-auth-token",
      "test_auth_token",
      "twilio-test-token",
      "twilio_test_token",
      // Explicit synthetic token documented in docs/VOICE_LOAD_TESTING.md.
      "callbackiq_voice_load_only_token",
    ].includes(value);
  }

  if (name === "OPENAI_API_KEY") {
    return [
      "test-openai-key",
      "test_openai_key",
      "openai-example",
      "openai_example",
    ].includes(value);
  }

  if (name === "STRIPE_SECRET_KEY") {
    return [
      "sk_test_123",
      "sk_test_example",
      "sk_test_fake",
      "sk_test_mock",
      "sk_test_dummy",
      "sk_test_placeholder",
    ].includes(value);
  }

  return false;
};

const isSafeMongoFixture = (rawValue) => {
  const value = String(rawValue || "")
    .trim()
    .replace(/[;,.)]+$/, "");

  /*
   * RFC-reserved .invalid hostnames are safe for committed fixtures.
   *
   * Keep this deliberately strict: credentials/userinfo before the host
   * are NOT allowed by this expression, so a URI containing an embedded
   * username/password remains eligible for secret detection.
   */
  if (
    /^mongodb(?:\+srv)?:\/\/example\.invalid(?::\d+)?(?:\/|$)/i.test(
      value,
    )
  ) {
    return true;
  }

  return /^mongodb:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(
    value,
  );
};

const scanSecrets = (text, relative) => {
  if (/\.env\.example$/i.test(relative)) {
    return;
  }

  for (const { name, regex } of credentialPatterns) {
    regex.lastIndex = 0;

    for (const match of text.matchAll(regex)) {
      const value = match[1];

      /*
       * In JavaScript, only inspect direct string-literal assignments.
       *
       * Examples that must NOT be treated as credentials:
       *   process.env.OPENAI_API_KEY = originalKey;
       *   process.env.TWILIO_AUTH_TOKEN = previous.authToken;
       *
       * Direct quoted credential literals remain eligible for scanning.
       */
      const isJavaScriptFile =
        /\.(?:js|jsx|mjs|cjs)$/i.test(relative);

      const matchedAssignment = match[0];
      const equalsIndex = matchedAssignment.indexOf("=");
      const assignedExpression =
        equalsIndex >= 0
          ? matchedAssignment.slice(equalsIndex + 1).trim()
          : "";

      const isQuotedLiteral =
        /^["'`]/.test(assignedExpression);

      if (isJavaScriptFile && !isQuotedLiteral) {
        continue;
      }

      if (isObviousPlaceholder(name, value)) {
        continue;
      }

      findings.push({
        type: "possible_secret",
        path: relative,
        credential: name,
      });
    }
  }

  mongoPattern.lastIndex = 0;

  for (const match of text.matchAll(mongoPattern)) {
    const value = match[0];

    if (isSafeMongoFixture(value)) {
      continue;
    }

    findings.push({
      type: "possible_secret",
      path: relative,
      credential: "MONGODB_URI",
    });
  }
};

/*
 * Repository hygiene is about what can be committed.
 *
 * Only inspect Git-tracked files. Local .env files, generated coverage,
 * node_modules, temporary backups, etc. must not fail CI merely because
 * they exist in a developer working tree.
 */
const trackedFiles = execFileSync(
  "git",
  ["ls-files", "-z"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean);

for (const relative of trackedFiles) {
  const normalized = relative.replaceAll("\\", "/");

  if (
    forbiddenPathPatterns.some((pattern) =>
      pattern.test(normalized),
    )
  ) {
    findings.push({
      type: "repository_artifact",
      path: relative,
    });

    continue;
  }

  const file = path.join(root, relative);

  // Can occur when a tracked file is staged for deletion.
  if (!fs.existsSync(file)) {
    continue;
  }

  const stat = fs.statSync(file);

  if (
    !stat.isFile() ||
    stat.size >= 2_000_000 ||
    !/\.(?:js|jsx|mjs|cjs|json|md|txt|env)$/i.test(relative)
  ) {
    continue;
  }

  const text = fs.readFileSync(file, "utf8");
  scanSecrets(text, relative);
}

console.log(
  JSON.stringify(
    {
      clean: findings.length === 0,
      trackedFilesScanned: trackedFiles.length,
      findings,
    },
    null,
    2,
  ),
);

if (strict && findings.length) {
  process.exitCode = 2;
}
