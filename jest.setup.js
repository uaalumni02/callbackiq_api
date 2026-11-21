process.env.JWT_SECRET = "test_secret_key";
process.env.NODE_ENV = "test";
process.env.SENTRY_DSN = "";
process.env.OPS_ALERT_WEBHOOK_URL = "";
process.env.TWILIO_AUTH_TOKEN = "synthetic-jest-twilio-auth-token";
process.env.TWILIO_WEBHOOK_BASE_URL = "https://api.example.test";
process.env.VOICE_WEBSOCKET_PUBLIC_URL = "wss://api.example.test/ws/voice";
// Legacy synchronous route fixtures; durable production path has dedicated integration tests.
process.env.RECOVERY_SMS_ASYNC_ENABLED = "false";

process.env.INTEGRATION_ENCRYPTION_KEY = 'synthetic-test-encryption-key-123456789012345';
