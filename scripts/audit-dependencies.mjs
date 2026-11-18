import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

function audit(args) {
  const run = spawnSync('npm', ['audit', '--json', ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (run.error) throw run.error;
  const report = JSON.parse(run.stdout);
  if (report.error || !report.vulnerabilities || ![0, 1].includes(run.status)) {
    throw new Error('Dependency audit did not return a complete report.');
  }
  return Object.values(report.vulnerabilities);
}

const allowlist = JSON.parse(fs.readFileSync(new URL('../config/development-advisories.json', import.meta.url)));
const today = new Date().toISOString().slice(0, 10);
for (const [id, entry] of Object.entries(allowlist)) {
  if (!entry.owner?.trim() || !entry.reason?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)
      || !Number.isFinite(Date.parse(entry.expires)) || new Date(entry.expires).toISOString().slice(0, 10) !== entry.expires) {
    throw new Error(`Development advisory ${id} needs an owner, reason, and valid expiry date.`);
  }
}

const runtime = audit(['--omit=dev']);
if (runtime.length) {
  console.error('Runtime dependency advisories:', runtime.map(vulnerability => vulnerability.name).join(', '));
  process.exitCode = 1;
} else {
  console.log('No runtime dependency advisories.');
}
const development = audit([]);
const known = new Set();
for (const finding of development.flatMap(vulnerability => vulnerability.via)) {
  if (typeof finding !== 'object' || known.has(finding.url)) continue;
  known.add(finding.url);
  const id = finding.url?.match(/GHSA-[a-z0-9-]+/i)?.[0];
  const entry = allowlist[id];
  const tracked = entry && entry.expires >= today
    ? `owner ${entry.owner}, expires ${entry.expires}`
    : 'owner/expiry review required';
  console.warn(`Full-tree advisory: ${finding.name} ${finding.url} (${tracked})`);
}
