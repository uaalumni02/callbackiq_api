# Twilio Auth Token Rotation Runbook

1. Create a secondary Auth Token in Twilio.
2. Add it to production as `TWILIO_AUTH_TOKEN_NEXT`.
3. Deploy dual-token validation and verify voice, SMS and status webhooks.
4. Promote the secondary token in Twilio.
5. Move the promoted value to `TWILIO_AUTH_TOKEN`.
6. Temporarily place the old value in `TWILIO_AUTH_TOKEN_PREVIOUS` only when
   delayed webhook delivery requires a short overlap.
7. Verify outbound REST authentication. Prefer API Key + API Secret for REST.
8. Monitor signature failures for voice, SMS, status and usage-trigger routes.
9. Remove `NEXT` and `PREVIOUS` after the overlap window.
10. Record the rotation date and operator in the security audit log.

Never log token values. Never disable signature validation to perform rotation.
