import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateMixedReport } from './acceptance.mjs';
if (process.env.SCALE_ALLOW_STAGING_LOAD !== 'true') throw new Error('Explicit staging load authorization required');
const root = path.resolve(process.env.SCALE_REPORT_DIR || `scale-soak-${Date.now()}`);
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const cohorts = Math.max(12, Math.min(48, Number(process.env.SCALE_SOAK_COHORTS) || 12));
const results = [];
for (let i = 0; i < cohorts; i++) {
  const dir = path.join(root, `cohort-${String(i + 1).padStart(2, '0')}`);
  const startedAt = new Date().toISOString();
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, ['perf/mixed-scale.mjs'], { stdio: 'inherit', env: { ...process.env,
      SCALE_REPORT_DIR: dir, SCALE_DURATION_MS: '300000', SCALE_BURST: i === 0 ? 'true' : 'false' } });
    const stop = () => child.kill('SIGTERM'); process.once('SIGTERM', stop); process.once('SIGINT', stop);
    child.once('error', () => resolve(1)); child.once('exit', code => { process.off('SIGTERM', stop); process.off('SIGINT', stop); resolve(code ?? 1); });
  });
  let errors = ['missing_report'];
  try { errors = validateMixedReport(JSON.parse(await fs.readFile(path.join(dir, 'mixed.json'), 'utf8'))); } catch {}
  results.push({ cohort: i + 1, startedAt, endedAt: new Date().toISOString(), code, errors });
  await fs.writeFile(path.join(root, 'soak.json'), JSON.stringify({ continuous: false, results,
    note: 'Repeated sustained cohorts; setup/outcome-audit intervals between cohorts are recorded, not counted as continuous active-call time.' }, null, 2));
  if (code || errors.length) { process.exitCode = 1; break; }
}
