import { numericSetting } from "./numericSettings.js";
/** Returns server-owned pilot allowances; owner settings never participate. */
export function pilotBudget(metric, source = process.env) {
  const prefix = {
    voice: "VOICE_SECONDS",
    sms: "SMS_SEGMENTS",
    ai: "AI_REQUESTS",
  }[metric];
  if (!prefix) throw new TypeError("Unsupported provider budget metric");
  const scale = metric === "voice" ? 60 : 1;
  const name = metric === "voice" ? "VOICE_MINUTES" : prefix;
  return {
    daily: numericSetting(`PILOT_${name}_DAY`, source) * scale,
    monthly: numericSetting(`PILOT_${name}_MONTH`, source) * scale,
    fleetDaily: numericSetting(`PILOT_FLEET_${name}_DAY`, source) * scale,
    fleetMonthly: numericSetting(`PILOT_FLEET_${name}_MONTH`, source) * scale,
  };
}
/** Projects the immutable customer voice plan; hard caps and no-overage are unconditional. */
export function pilotVoiceLimits(source = process.env) {
  const limits = pilotBudget("voice", source);
  return {
    dailySeconds: limits.daily,
    monthlySeconds: limits.monthly,
    hardCapEnabled: true,
    overageEnabled: false,
    warningThresholds: [70, 85, 100],
  };
}
/** Reads the operator circuit breaker; malformed values fail closed. */
export const providerDispatchPaused = (source = process.env) =>
  !["", "false"].includes(
    String(source.PILOT_PROVIDER_DISPATCH_PAUSED || "").toLowerCase(),
  );
/** Replaces legacy editable budget fields before publishing settings; unrelated routing settings remain intact. */
export function withPilotVoiceBudget(settings) {
 const limits=pilotVoiceLimits();
 return {...settings,dailyVoiceMinutes:limits.dailySeconds/60,monthlyVoiceMinutes:limits.monthlySeconds/60,voiceHardCapEnabled:true,voiceOverageEnabled:false};
}
