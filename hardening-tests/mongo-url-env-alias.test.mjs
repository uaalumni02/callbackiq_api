import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvironment } from '../src/config/env.js';
import { getMongoUrl, normalizeRuntimeEnvironment } from '../src/config/runtime-environment.js';

const source = () => ({
  APP_ENV: 'staging',
  NODE_ENV: 'production',
  JWT_SECRET: 'a'.repeat(64),
  CLIENT_URL: 'https://staging.callbackiq.test',
  PUBLIC_API_URL: 'https://api.callbackiq.test',
  ALLOWED_ORIGINS: 'https://staging.callbackiq.test',
  TWILIO_ACCOUNT_SID: 'AC' + '1'.repeat(32),
  TWILIO_AUTH_TOKEN: 'non-placeholder-secret',
  STRIPE_SECRET_KEY: 'sk_test_valid',
  STRIPE_WEBHOOK_SECRET: 'whsec_valid',
  OPENAI_API_KEY: 'sk-valid-for-test',
  STAGING_DATABASE_ISOLATED: 'true',
  DUMMY_PASSWORD_HASH: 'configured',
});
const url = 'mongodb://127.0.0.1:27017/callbackiq_test';

test('MONGO_URL alone passes the staging startup validator', () => {
  const result = validateEnvironment({ ...source(), MONGO_URL: url }, { throwOnError: false });
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('MONGO_URI alone passes the staging startup validator', () => {
  const result = validateEnvironment({ ...source(), MONGO_URI: url }, { throwOnError: false });
  assert.deepEqual(result.errors, []);
});

test('MONGODB_URI remains preferred', () => {
  const env = { ...source(), MONGO_URL: 'mongodb://127.0.0.1/legacy', MONGODB_URI: url };
  assert.equal(getMongoUrl(env), url);
  assert.equal(validateEnvironment(env, { throwOnError: false }).valid, true);
});

test('placeholder canonical URI does not silently use a legacy value', () => {
  const result = validateEnvironment({ ...source(), MONGODB_URI: 'replace-me', MONGO_URL: url }, { throwOnError: false });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /MONGODB_URI/);
});

test('missing and placeholder legacy values are rejected', () => {
  for (const env of [source(), { ...source(), MONGO_URL: 'replace-me' }]) {
    const result = validateEnvironment(env, { throwOnError: false });
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /MONGODB_URI/);
  }
});

test('runtime normalization still populates MONGODB_URI from MONGO_URL', () => {
  const env = { ...source(), MONGO_URL: url };
  normalizeRuntimeEnvironment(env);
  assert.equal(env.MONGODB_URI, url);
  assert.equal(validateEnvironment(env, { throwOnError: false }).valid, true);
});
