import { spawnSync } from 'node:child_process';
const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' });
if (shallow.status !== 0 || shallow.stdout.trim() !== 'false') throw new Error('Full history is required. Fetch all authorized branches/history before scanning.');
const result = spawnSync('gitleaks', ['detect', '--source', '.', '--log-opts=--all', '--redact'], { stdio: 'inherit' });
if (result.error) { console.error('Install gitleaks, then rerun. No history scan has been completed.'); process.exitCode = 2; }
else process.exitCode = result.status ?? 2;
