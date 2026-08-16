import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const strictAuthStorage =
  String(process.env.SECURITY_AUDIT_STRICT_AUTH_STORAGE || "") === "1";

const fail = [];
const warn = [];

const git = (...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

let tracked = [];
try {
  tracked = git("ls-files", "-z").split("\0").filter(Boolean);
} catch (error) {
  console.error("security audit requires a git working tree");
  process.exit(2);
}

const isTextCandidate = (file) =>
  !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp3|mp4|mov)$/i.test(
    file,
  );

const badTrackedArtifact = (file) =>
  /(^|\/)\.env($|\.)/.test(file) &&
  !/\.example$/.test(file) ||
  /(^|\/)\.callbackiq-.*backups?/i.test(file) ||
  /\.(bak|backup)([-.]|$)/i.test(file) ||
  /\.before-[^/]+$/i.test(file);

for (const file of tracked) {
  if (badTrackedArtifact(file)) {
    fail.push({
      rule: "tracked-sensitive-or-backup-artifact",
      file,
    });
  }
}

const secretRules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["stripe-live-secret", /\bsk_live_[A-Za-z0-9]{16,}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ["openai-secret", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
];

for (const file of tracked) {
  if (!isTextCandidate(file)) continue;

  const absolute = path.join(root, file);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    continue;
  }

  if (!stat.isFile() || stat.size > 2_000_000) continue;

  let text;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch {
    continue;
  }

  for (const [rule, regex] of secretRules) {
    if (regex.test(text)) {
      fail.push({ rule, file });
    }
  }

  if (
    /\blocalStorage\.(?:setItem|getItem)\(\s*["'`](?:token|accessToken|authToken)["'`]/.test(
      text,
    )
  ) {
    const finding = {
      rule: "browser-auth-token-in-localstorage",
      file,
    };
    (strictAuthStorage ? fail : warn).push(finding);
  }

  if (/\bdangerouslySetInnerHTML\b/.test(text)) {
    warn.push({ rule: "react-html-sink-review", file });
  }

  if (/\b(?:eval|Function)\s*\(/.test(text)) {
    warn.push({ rule: "dynamic-code-execution-review", file });
  }

  if (/\bconsole\.(?:error|warn)\s*\(/.test(text) && file.startsWith("src/")) {
    warn.push({ rule: "direct-console-bypasses-structured-logger", file });
  }
}

const unique = (items) =>
  [...new Map(items.map((item) => [`${item.rule}:${item.file}`, item])).values()];

const result = {
  repository: path.basename(root),
  trackedFiles: tracked.length,
  failures: unique(fail),
  warnings: unique(warn),
};

console.log(JSON.stringify(result, null, 2));

if (result.failures.length > 0) {
  console.error(
    `Security repository audit failed with ${result.failures.length} blocking finding(s).`,
  );
  process.exit(1);
}

console.log(
  `Security repository audit passed with ${result.warnings.length} warning(s).`,
);
