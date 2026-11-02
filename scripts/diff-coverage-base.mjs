/**
 * Canonical Git base selector shared by coverage discovery and LCOV verification.
 * Explicit CI references are mandatory and invalid refs fail closed. Local
 * architecture branches compare against their real development merge-base.
 */
import { execFileSync } from 'node:child_process';

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const exists = (cwd, ref) => {
  try { git(cwd, 'rev-parse', '--verify', `${ref}^{commit}`); return true; }
  catch { return false; }
};

export function resolveDiffCoverageBase({ cwd = process.cwd(), env = process.env } = {}) {
  const explicit = String(env.DIFF_COVERAGE_BASE || '').trim();
  if (explicit) {
    if (/^0+$/.test(explicit) || !exists(cwd, explicit)) {
      throw new Error(`Invalid DIFF_COVERAGE_BASE: ${explicit}. Fetch the base commit; do not skip the coverage gate.`);
    }
    return explicit;
  }
  const githubBase = String(env.GITHUB_BASE_REF || '').trim();
  if (githubBase) {
    if (!exists(cwd, `origin/${githubBase}`)) {
      throw new Error(`Missing origin/${githubBase} for diff coverage. Fetch the base branch.`);
    }
    return git(cwd, 'merge-base', 'HEAD', `origin/${githubBase}`);
  }
  const branch = git(cwd, 'branch', '--show-current');
  if (branch.startsWith('architecture/') && exists(cwd, 'origin/development')) {
    const ancestor = git(cwd, 'merge-base', 'HEAD', 'origin/development');
    if (ancestor !== git(cwd, 'rev-parse', 'HEAD')) return ancestor;
  }
  if (exists(cwd, 'HEAD^')) return 'HEAD^';
  throw new Error('No comparable Git base commit. Fetch development/main or specify DIFF_COVERAGE_BASE.');
}

export function assertNoUntrackedSources({ cwd = process.cwd() } = {}) {
  const raw = git(cwd, 'ls-files', '--others', '--exclude-standard', '--', 'src');
  const files = raw.split(/\r?\n/).filter(f => /\.(?:js|jsx|mjs|cjs|ts|tsx)$/.test(f));
  if (files.length) {
    throw new Error(`Untracked production files are invisible to git diff: ${files.join(', ')}. Add them to Git before coverage certification.`);
  }
}
