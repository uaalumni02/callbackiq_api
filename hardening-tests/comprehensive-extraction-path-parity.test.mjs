import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const modulePath = 'src/db/repositories/extracted/business-1.js';
const guard = path.join(
  root, 'scripts/meekcall-comprehensive-architecture-guard.cjs'
);
const source = fs.readFileSync(
  path.join(root, modulePath), 'utf8'
);
const config = JSON.parse(fs.readFileSync(
  path.join(root, 'config/meekcall-comprehensive-architecture.json'),
  'utf8'
));

const records = config.records.filter(
  record => record.module === modulePath
);
assert.ok(records.some(row=>row.name==='deleteBusinessByOwner'));
assert.ok(records.some(row=>row.name==='getBusinessByPhone'));
assert.ok(!records.some(row=>['deleteBusiness','updateBusiness'].includes(row.name)));

function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length - 1, 1);
  return text.replace(before, after);
}

function verify(contents) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'meekcall-parity-')
  );

  try {
    const dest = path.join(dir, modulePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, contents);

    const configPath = path.join(
      dir, 'config/meekcall-comprehensive-architecture.json'
    );
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      records,
      reviewedModuleImports: { [modulePath]: config.reviewedModuleImports[modulePath] },
    }));

    // The guard resolves root from __dirname, not cwd.
    // Copy it into the isolated fixture so mutations are tested.
    const fixtureGuard = path.join(
      dir,
      'scripts/meekcall-comprehensive-architecture-guard.cjs'
    );

    fs.mkdirSync(path.dirname(fixtureGuard), {
      recursive: true
    });

    fs.copyFileSync(guard, fixtureGuard);

    const result = spawnSync(
      process.execPath,
      [fixtureGuard],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          NODE_PATH: [
            path.join(root, 'node_modules'),
            process.env.NODE_PATH
          ].filter(Boolean).join(path.delimiter)
        }
      }
    );

    if (result.error) throw result.error;
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('accepts the transition relocation while retaining the original deletion hashes', () => {
  const result = verify(source);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS:/);
});

test('rejects changed business deletion scope', () => {
  const altered = replaceOnce(
    source,
    'return await deleteBusinessSafely({ ownerId });',
    'return await deleteBusinessSafely({ businessId: ownerId });'
  );
  const result = verify(altered);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /extracted body changed/);
});

test('rejects incorrect relocated import path', () => {
  const altered = source.replaceAll(
    '../../../services/businessDeletion.service.js',
    '../services/businessDeletion.service.js'
  );
  assert.notEqual(altered, source);
  const result = verify(altered);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid reviewed relocation/);
});

test('continues protecting unrelated business methods', () => {
  const altered = replaceOnce(
    source,
    'return await model.findOne({',
    'return await model.findOne({ isActive: true,'
  );
  const result = verify(altered);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /extracted body changed: .*getBusinessByPhone/
  );
});
