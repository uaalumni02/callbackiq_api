import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const guardPath = path.resolve(
  'scripts/meekcall-release9-architecture-guard.mjs'
);

const reviewed = [
  'alerts-1.js',
  'business-1.js',
  'calls-1.js',
  'conversations-1.js',
  'demo-1.js',
  'identity-1.js',
  'intelligence-1.js',
  'leads-1.js',
  'messages-1.js',
  'operations-1.js',
  'reporting-1.js',
  'trial-1.js',
];

function runFixture({ extraImport = '', extraFiles = {} } = {}) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'meekcall-release9-')
  );

  try {
    const files = {
      'config/meekcall-release9-architecture-baseline.json':
        JSON.stringify({
          schema: 1,
          protectedEdges: { 'src/db/db.js': [] },
          existingCycles: [],
          pureExceptions: {},
          sizes: {},
        }),
      'src/db/db.js':
        reviewed.map(name =>
          `import './repositories/extracted/${name}';`
        ).join('\n') + '\n' + extraImport,
    };

    for (const name of reviewed) {
      files[`src/db/repositories/extracted/${name}`] =
        'export const present = true;\n';
    }

    Object.assign(files, extraFiles);

    for (const [name, contents] of Object.entries(files)) {
      const destination = path.join(dir, name);
      fs.mkdirSync(path.dirname(destination), {
        recursive: true,
      });
      fs.writeFileSync(destination, contents);
    }

    const result = spawnSync(
      process.execPath,
      [guardPath, '--check'],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 15000,
      }
    );

    if (result.error) throw result.error;
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('permits only reviewed intra-database imports', () => {
  const result = runFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /PASS architecture regression gate/
  );
});

test('rejects an unreviewed extracted repository', () => {
  const result = runFixture({
    extraImport:
      "import './repositories/extracted/future-1.js';\n",
    extraFiles: {
      'src/db/repositories/extracted/future-1.js':
        'export const future = true;\n',
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /New cross-layer dependency src\/db\/db\.js -> src\/db\/repositories\/extracted\/future-1\.js/
  );
});

test('rejects a new database-to-controller dependency', () => {
  const result = runFixture({
    extraImport: "import '../controllers/prohibited.js';\n",
    extraFiles: {
      'src/controllers/prohibited.js':
        'export const prohibited = true;\n',
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /New cross-layer dependency src\/db\/db\.js -> src\/controllers\/prohibited\.js/
  );
});

test('continues rejecting newly introduced cycles', () => {
  const result = runFixture({
    extraFiles: {
      'src/db/repositories/extracted/alerts-1.js':
        "import '../../db.js';\n",
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /New dependency cycle:/);
});
