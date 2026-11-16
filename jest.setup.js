process.env.JWT_SECRET = "test_secret_key";
process.env.NODE_ENV = "test";
// Legacy synchronous route fixtures; durable production path has dedicated integration tests.
process.env.RECOVERY_SMS_ASYNC_ENABLED = "false";

process.env.INTEGRATION_ENCRYPTION_KEY = 'synthetic-test-encryption-key-123456789012345';
