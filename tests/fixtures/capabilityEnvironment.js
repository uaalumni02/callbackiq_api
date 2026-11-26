/** Returns inert complete capability configuration for startup-only tests; never contacts providers. */
export function capabilityEnvironment(){return {
 TURNSTILE_SECRET_KEY:'synthetic-turnstile-secret',TWILIO_VERIFY_SERVICE_SID:'VE'+'0'.repeat(32),
 STRIPE_PRO_PRICE_ID:'price_synthetic_pro',STRIPE_BILLING_PORTAL_CONFIGURATION_ID:'bpc_synthetic',
 TWILIO_PRIMARY_CUSTOMER_PROFILE_SID:'BU'+'0'.repeat(32),A2P_NOTIFICATION_EMAIL:'synthetic@example.test',
 A2P_EVENT_STREAM_USERNAME:'synthetic-stream',A2P_EVENT_STREAM_PASSWORD:'synthetic-stream-secret',
 GOOGLE_CALENDAR_CLIENT_ID:'synthetic-client',GOOGLE_CALENDAR_CLIENT_SECRET:'synthetic-client-secret',
 GOOGLE_CALENDAR_REDIRECT_URI:'https://api.callbackiq.test/oauth/callback',OAUTH_STATE_SECRET:'synthetic-state-secret-long-enough',
 INTEGRATION_ENCRYPTION_KEY:'synthetic-encryption-key-long-enough-1234567890',
 VOICE_WEBSOCKET_PUBLIC_URL:'wss://api.callbackiq.test/ws/voice',
 SMTP_HOST:'smtp.synthetic.test',SMTP_USER:'synthetic@example.test',SMTP_PASSWORD:'synthetic-unusable-password',
 STAFF_NOTIFICATION_EMAIL_ENABLED:'true',STAFF_NOTIFICATION_SMS_ENABLED:'true',STAFF_APPROVAL_SMS_ENABLED:'true',
};}
