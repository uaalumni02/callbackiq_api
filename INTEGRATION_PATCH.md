# API integration patch

This is an additive overlay. Copy `src`, `tests`, and `docs` into the API repo.

Then make these small edits:

## `src/app.js`

```js
import voiceOperationsRoutes from "./routes/voiceOperations.routes.js";
app.use("/api/voice-operations", voiceOperationsRoutes);
```

## Twilio signature middleware and ConversationRelay validator

Replace the direct call to `twilio.validateRequest(authToken, ...)` with:

```js
import {
  validateTwilioRequestWithRotation,
} from "../services/twilioSignatureRotation.service.js";

return validateTwilioRequestWithRotation({
  signature,
  url: publicUrl,
  params: req.body || {},
});
```

For the WebSocket validator, pass `{}` as params.

## Voice-session setup

```js
const fraud = await VoiceFraudDetectionService.evaluateCallerVelocity({
  businessId: session.business?._id || session.business,
  callerPhone: session.from,
});
if (!fraud.allowed) {
  await persistFallbackSafely(fraud.reason);
  sendEndPacket("callback_fallback", fraud.reason);
  return;
}

const usage = await VoiceUsageService.reserveVoiceUsage({
  business: session.business,
  sessionId: session._id,
  reserveSeconds: 60,
});
if (!usage.allowed) {
  await persistFallbackSafely(usage.reason);
  sendEndPacket("callback_fallback", usage.reason);
  return;
}
session.voiceUsageReservedSeconds = usage.reservedSeconds;
```

## Voice-session close/finalize

```js
await VoiceUsageService.reconcileVoiceUsage({
  businessId: session.business?._id || session.business,
  sessionId: session._id,
  reservedSeconds: session.voiceUsageReservedSeconds || 0,
  actualSeconds: session.durationSeconds || 0,
  openAiInputTokens: session.openAiUsage?.inputTokens || 0,
  openAiOutputTokens: session.openAiUsage?.outputTokens || 0,
  transferAttempts: session.transferAttempts || 0,
});
```

## Business voice settings

Add these properties to the existing `voiceSettings` schema:

```js
dailyVoiceMinutes: { type: Number, default: 240, min: 1, max: 100000 },
monthlyVoiceMinutes: { type: Number, default: 4000, min: 1, max: 1000000 },
voiceHardCapEnabled: { type: Boolean, default: true },
voiceOverageEnabled: { type: Boolean, default: false },
voiceUsageWarningThresholds: { type: [Number], default: [70, 85, 100] },
callerVelocityLimitPerHour: { type: Number, default: 10, min: 1, max: 1000 },
agentConfirmationRequired: { type: Boolean, default: true },
answeringMachineDetectionEnabled: { type: Boolean, default: true },
```
