// Never read .env or use the developer's MONGO_URL. The suite creates its own DB.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'browser-test-only-not-a-production-secret';
process.env.CLIENT_URL = 'http://127.0.0.1:43771';
process.env.PUBLIC_API_URL = 'http://127.0.0.1:43771';
process.env.RECOVERY_SMS_ASYNC_ENABLED = 'false';
process.env.SMS_TURN_AGGREGATION_WINDOW_MS = '0';
