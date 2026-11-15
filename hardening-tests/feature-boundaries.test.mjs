import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditImports } from '../scripts/import-graph-audit.mjs';

const profiles = {
  callbackiq_api: {
    protected: ['src/services/booking/bookingClassification.policy.js',
      'src/services/booking/bookingConversation.repository.js', 'src/db/repositories/userIdentityRepository.js'],
    entry: 'src/services/booking/newDecision.policy.js',
    forbidden: 'src/models/record.js',
  },
  callbackiq_frontend: {
    protected: ['src/features/billing/createBillingSubscriptionActions.js',
      'src/features/billing/createSupportTicketActions.js', 'src/features/appointments/createSchedulingLeadPrefillEffect.js',
      'src/features/conversations/createManualReplyAction.js'],
    entry: 'src/features/leads/newEditor.js',
    forbidden: 'src/pages/Leads.js',
  },
};
function fixture(t, repository) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-boundaries-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, source) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };
  write('package.json', JSON.stringify({ name: repository }));
  for (const file of profiles[repository].protected) write(file, 'export const valid = true;');
  const specifier = (from, to) => {
    const target = path.posix.relative(path.posix.dirname(from), to);
    return target.startsWith('.') ? target : './' + target;
  };
  return { root, write, specifier, ...profiles[repository] };
}

for (const repository of Object.keys(profiles)) {
  test(`${repository}: forbidden require remains blocked through a symlinked checkout root`, t => {
    const f = fixture(t, repository);
    const aliases = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-boundary-alias-'));
    t.after(() => fs.rmSync(aliases, { recursive: true, force: true }));
    const alias = path.join(aliases, 'checkout');
    fs.symlinkSync(fs.realpathSync(f.root), alias, 'dir');
    f.write(f.forbidden, 'export const valid = true;');
    f.write(f.entry, `const load = require('${f.specifier(f.entry, f.forbidden)}');`);
    assert.throws(() => auditImports(alias), /forbidden import/);
  });

  test(`${repository}: an acyclic selected feature can depend on a shared pure helper`, t => {
    const f = fixture(t, repository);
    f.write('src/lib/value.js', 'export const value = 1;');
    f.write(f.entry, `export { value } from '${f.specifier(f.entry, 'src/lib/value.js')}';`);
    assert.ok(auditImports(f.root).featureBoundaryFiles > 0);
  });

  for (const kind of ['static', 'reexport', 'dynamic', 'require']) {
    test(`${repository}: ${kind} import of a forbidden layer fails`, t => {
      const f = fixture(t, repository), target = f.specifier(f.entry, f.forbidden);
      f.write(f.forbidden, 'export const valid = true;');
      const sources = {
        static: `import '${target}';`, reexport: `export * from '${target}';`,
        dynamic: `export const load = () => import('${target}');`, require: `const load = require('${target}');`,
      };
      f.write(f.entry, sources[kind]);
      assert.throws(() => auditImports(f.root), /forbidden import/);
    });
  }

  test(`${repository}: a shared helper cannot hide a forbidden transitive import`, t => {
    const f = fixture(t, repository);
    f.write(f.forbidden, 'export const valid = true;');
    f.write('src/lib/value.js', `export * from '${f.specifier('src/lib/value.js', f.forbidden)}';`);
    f.write(f.entry, `import '${f.specifier(f.entry, 'src/lib/value.js')}';`);
    assert.throws(() => auditImports(f.root), /forbidden import.*dependency chain:.*value\.js/s);
  });

  for (const dependency of ['mongoose', 'twilio', 'stripe']) {
    test(`${repository}: provider/persistence dependency ${dependency} fails`, t => {
      const f = fixture(t, repository);
      f.write(`node_modules/${dependency}/package.json`, JSON.stringify({ main: 'index.js' }));
      f.write(`node_modules/${dependency}/index.js`, 'module.exports = {};');
      f.write(f.entry, `import '${dependency}';`);
      assert.throws(() => auditImports(f.root), /forbidden import/);
    });
  }

  test(`${repository}: a new cycle crossing the selected boundary fails`, t => {
    const f = fixture(t, repository);
    f.write(f.entry, `import '${f.specifier(f.entry, 'src/lib/value.js')}';`);
    f.write('src/lib/value.js', `import '${f.specifier('src/lib/value.js', f.entry)}';`);
    assert.throws(() => auditImports(f.root), /dependency cycle/);
  });

  test(`${repository}: a cycle inside the selected feature's dependency closure fails`, t => {
    const f = fixture(t, repository);
    f.write(f.entry, `import '${f.specifier(f.entry, 'src/lib/a.js')}';`);
    f.write('src/lib/a.js', "import './b.js';");
    f.write('src/lib/b.js', "import './a.js';");
    assert.throws(() => auditImports(f.root), /dependency cycle/);
  });

  test(`${repository}: absolute local paths cannot hide a boundary cycle`, t => {
    const f = fixture(t, repository);
    f.write(f.entry, `import '${path.join(f.root, 'src/lib/value.js')}';`);
    f.write('src/lib/value.js', `import '${path.join(f.root, f.entry)}';`);
    assert.throws(() => auditImports(f.root), /dependency cycle/);
  });

  for (const kind of ['static', 'reexport', 'dynamic', 'require']) {
    for (const violation of ['forbidden import', 'dependency cycle']) {
      test(`${repository}: ${kind} absolute import through a path alias rejects ${violation}`, t => {
        const f = fixture(t, repository);
        const aliases = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-target-alias-'));
        t.after(() => fs.rmSync(aliases, { recursive: true, force: true }));
        const alias = path.join(aliases, 'checkout');
        fs.symlinkSync(fs.realpathSync(f.root), alias, 'dir');
        const destination = violation === 'forbidden import' ? f.forbidden : 'src/lib/value.js';
        f.write(destination, violation === 'forbidden import' ? 'export const valid = true;'
          : `import '${f.specifier(destination, f.entry)}';`);
        const target = JSON.stringify(path.join(alias, destination));
        const sources = {
          static: `import ${target};`, reexport: `export * from ${target};`,
          dynamic: `export const load = () => import(${target});`, require: `const load = require(${target});`,
        };
        f.write(f.entry, sources[kind]);
        assert.throws(() => auditImports(f.root), new RegExp(violation));
      });
    }
  }

  test(`${repository}: the original named cycle set still fails independently`, t => {
    const f = fixture(t, repository), original = f.protected[0];
    f.write(original, `import '${f.specifier(original, 'src/lib/value.js')}';`);
    f.write('src/lib/value.js', `import '${f.specifier('src/lib/value.js', original)}';`);
    assert.throws(() => auditImports(f.root), /Protected module cycle/);
  });
}

test('callbackiq_api: reschedule phases reject a transitive infrastructure import', t => {
  const f = fixture(t, 'callbackiq_api');
  const entry = 'src/services/scheduling/reschedule/providerHandoff.js';
  f.write(entry, "import '../../../lib/intermediate.js';");
  f.write('src/lib/intermediate.js', "import '../models/record.js';");
  f.write('src/models/record.js', 'export const record = true;');
  assert.throws(() => auditImports(f.root), /Reschedule command forbidden import/);
});
