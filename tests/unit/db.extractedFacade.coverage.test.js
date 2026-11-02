/**
 * Coverage and public-contract tests for the 57 extracted Db facade methods.
 * Each mock is scoped to this test file; other suites exercise the real repositories.
 * We prove the facade still forwards every argument, return value, error and `this`.
 */
import fs from 'node:fs';
import path from 'node:path';
import Db from '../../src/db/db.js';

jest.mock('../../src/db/repositories/extracted/identity-1.js', () => ({
  __esModule: true,
  createDbidentity1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

jest.mock('../../src/db/repositories/extracted/operations-1.js', () => ({
  __esModule: true,
  createDboperations1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

jest.mock('../../src/db/repositories/extracted/business-1.js', () => ({
  __esModule: true,
  createDbbusiness1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

jest.mock('../../src/db/repositories/extracted/leads-1.js', () => ({
  __esModule: true,
  createDbleads1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

jest.mock('../../src/db/repositories/extracted/conversations-1.js', () => ({
  __esModule: true,
  createDbconversations1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

jest.mock('../../src/db/repositories/extracted/messages-1.js', () => ({
  __esModule: true,
  createDbmessages1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

jest.mock('../../src/db/repositories/extracted/calls-1.js', () => ({
  __esModule: true,
  createDbcalls1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

jest.mock('../../src/db/repositories/extracted/reporting-1.js', () => ({
  __esModule: true,
  createDbreporting1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

jest.mock('../../src/db/repositories/extracted/alerts-1.js', () => ({
  __esModule: true,
  createDbalerts1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

jest.mock('../../src/db/repositories/extracted/trial-1.js', () => ({
  __esModule: true,
  createDbtrial1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

jest.mock('../../src/db/repositories/extracted/demo-1.js', () => ({
  __esModule: true,
  createDbdemo1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

jest.mock('../../src/db/repositories/extracted/intelligence-1.js', () => ({
  __esModule: true,
  createDbintelligence1Methods: jest.fn(() => new Proxy(Object.create(null), {
    get: (_target, name) => function (...args) {
      if (args[0] instanceof Error) throw args[0];
      return { name, args, receiver: this };
    },
  })),
}));

const facade = fs.readFileSync(path.join(process.cwd(), 'src/db/db.js'), 'utf8');
const delegatedMethods = [...facade.matchAll(
  /static async (\w+)\(\.\.\.args\)\s*\{\s*return __meekcallGetDb\w+Methods\(\)\.\1\.apply\(this,\s*args\);\s*\}/g,
)].map(m => m[1]);

test('the complete 57-method extracted facade remains available', () => {
  expect(delegatedMethods).toHaveLength(57);
  expect(new Set(delegatedMethods).size).toBe(57);
});

test.each(delegatedMethods)('Db.%s preserves arguments, receiver and return value', async (name) => {
  const model = { fixture: 'model' };
  const scope = { businessId: 'tenant-1', lifecycle: 'held' };
  const value = await Db[name](model, 'record-1', scope);
  expect(value.name).toBe(name);
  expect(value.args).toEqual([model, 'record-1', scope]);
  expect(value.receiver).toBe(Db);
});

test.each(delegatedMethods)('Db.%s propagates the original repository error', async (name) => {
  const sentinel = new Error(`expected ${name} repository failure`);
  await expect(Db[name](sentinel)).rejects.toBe(sentinel);
});
