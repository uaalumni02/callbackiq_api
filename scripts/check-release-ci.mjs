// Read-only GitHub check. GH_TOKEN/GITHUB_TOKEN is needed for a private repo.
import { execFileSync } from 'node:child_process';
const repo = process.env.GITHUB_REPOSITORY || 'uaalumni02/callbackiq_api';
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid repository name');
const sha = process.env.RELEASE_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Exact release SHA required');
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const get = async route => {
  const r = await fetch(`https://api.github.com/repos/${repo}/${route}`, { headers: {
    accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}),
  }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!r.ok) throw new Error(`GitHub HTTP ${r.status}; verify repository access/token and account settings`);
  return r.json();
};
try {
  const { workflow_runs: runs } = await get(`actions/runs?head_sha=${sha}&branch=main&per_page=100`);
  const rows = [];
  for (const name of ['API CI', 'Security', 'Customer and staff browser workflows']) {
    const run = runs.filter(r => r.name === name && r.head_sha === sha && r.head_branch === 'main').sort((a,b) => b.id - a.id)[0];
    rows.push({ name, status: run?.status || 'missing', conclusion: run?.conclusion || 'unverified', url: run?.html_url });
  }
  const passed = rows.every(r => r.status === 'completed' && r.conclusion === 'success');
  console.log(JSON.stringify({ sha, passed, workflows: rows,
    nextStep: passed ? 'Run deployed capacity acceptance.' : 'Inspect failed/missing runs. Billing/spending blocks require the account owner to fix GitHub Billing & plans, then rerun. Do not treat Dependabot success as release certification.' }, null, 2));
  if (!passed) process.exitCode = 1;
} catch(error) { console.error(error.message); process.exitCode = 1; }
