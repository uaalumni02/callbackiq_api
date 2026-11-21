import { BUSINESS_TYPES } from '../../src/helpers/businessTypes.js';
import { buildTwilioWebhookUrls } from '../../src/services/twilioWebhookReliability.service.js';
import { buildSmsRecoveryVoicePrompt } from '../../src/voice/smsRecoveryVoicePrompt.service.js';

describe('MeekCall multi-industry and migration safety', () => {
  test('only supported home-service categories are selectable', () => {
    for (const type of ['plumbing','hvac','roofing','electrical','restoration','garage_door','locksmith','landscaping','appliance_repair','pest_control','cleaning','other']) expect(BUSINESS_TYPES).toContain(type);
    expect(BUSINESS_TYPES).toHaveLength(12);
    expect(BUSINESS_TYPES).not.toContain('dental');
    expect(new Set(BUSINESS_TYPES).size).toBe(BUSINESS_TYPES.length);
  });
  test('fallback gate is opt-in and rejects same-origin fallback', () => {
    const base = 'https://primary.example';
    const env = { MEEKCALL_REQUIRE_INDEPENDENT_TWILIO_FALLBACK: 'true', TWILIO_FALLBACK_WEBHOOK_BASE_URL: base };
    expect(() => buildTwilioWebhookUrls(base, env)).toThrow(/independent HTTPS origin/);
    expect(buildTwilioWebhookUrls(base, {...env, TWILIO_FALLBACK_WEBHOOK_BASE_URL:'https://backup.example'}).voiceFallbackUrl).toContain('backup.example');
    expect(buildTwilioWebhookUrls(base, {}).voiceUrl).toContain('primary.example');
  });
  test('concise script never promises a text that was not sent', () => {
    const prior = process.env.MEEKCALL_CONCISE_MISSED_CALL_PROMPT;
    try {
      process.env.MEEKCALL_CONCISE_MISSED_CALL_PROMPT = 'true';
      const info = {businessName:'Example Dental', smsEnabled:true};
      expect(buildSmsRecoveryVoicePrompt({...info,smsStatus:'sent'})).toMatch(/just sent you a text/);
      expect(buildSmsRecoveryVoicePrompt({...info,smsStatus:'queued'})).not.toMatch(/just sent you a text/);
      expect(buildSmsRecoveryVoicePrompt({...info,smsStatus:'suppressed'})).not.toMatch(/just sent you a text/);
    } finally {
      if(prior===undefined) delete process.env.MEEKCALL_CONCISE_MISSED_CALL_PROMPT;
      else process.env.MEEKCALL_CONCISE_MISSED_CALL_PROMPT=prior;
    }
  });
});
