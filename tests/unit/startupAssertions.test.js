import { assertStandaloneRuntime } from '../../src/config/startupAssertions.js';

test('rejects a standalone server or worker using the test environment', () => {
  expect(() => assertStandaloneRuntime({NODE_ENV: 'test'})).toThrow('reserved for Jest');
});
test.each(['development', 'staging', 'production'])('allows %s processes', NODE_ENV => {
  expect(() => assertStandaloneRuntime({NODE_ENV})).not.toThrow();
});
test('allows Jest to exercise startup', () => {
  expect(() => assertStandaloneRuntime({NODE_ENV: 'test', JEST_WORKER_ID: '1'})).not.toThrow();
});
