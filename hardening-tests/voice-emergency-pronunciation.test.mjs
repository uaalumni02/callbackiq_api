import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmergencyNumberForSpeech } from '../src/voice/voiceSpeech.service.js';
import { toSpokenReply } from '../src/voice/voiceInput.service.js';
import { conversationRelayTwiml, sayTwiml, normalizeVoiceSettings } from '../src/voice/voiceRouting.service.js';
import { buildSmsRecoveryVoicePrompt } from '../src/voice/smsRecoveryVoicePrompt.service.js';

test('emergency digits are unambiguous and normalization is idempotent', () => {
  for (const number of ['911', '9 1 1', '9-1-1']) {
    const output = normalizeEmergencyNumberForSpeech(`Call ${number} now.`);
    assert.equal(output, 'Call nine one one now.');
    assert.equal(normalizeEmergencyNumberForSpeech(output), output);
  }
  assert.equal(normalizeEmergencyNumberForSpeech(null), '');
});
test('other numbers and identifiers are preserved', () => {
  const input = '1911 9110 30324 404-911-1234 +911234567890 AB911 9:11';
  assert.equal(normalizeEmergencyNumberForSpeech(input), input);
});
test('relay replies pronounce emergency number individually', () => {
  assert.equal(toSpokenReply('For immediate danger, call 911.'), 'For immediate danger, call nine one one.');
});
test('default and custom relay greetings normalize speech and retain XML escaping', () => {
  for (const greeting of [undefined, 'A & B: call 911 for immediate danger.']) {
    const xml = conversationRelayTwiml({ greeting, businessName: 'A & B', websocketUrl: 'wss://example.com/voice' });
    assert.match(xml, /call nine one one/);
    assert.doesNotMatch(xml, /call 911/);
    assert.match(xml, /&amp;/);
  }
  assert.match(normalizeVoiceSettings({ businessName: 'Example' }).welcomeGreeting, /call 911/);
});
test('fallback Say normalizes speech without weakening XML escaping', () => {
  assert.match(sayTwiml('Call 911. A & B <test>'), /Call nine one one\. A &amp; B &lt;test&gt;/);
});
test('every SMS recovery voice outcome pronounces the digits', () => {
  for (const smsStatus of ['sent', 'queued', 'suppressed', 'failed', 'disabled']) {
    const prompt = buildSmsRecoveryVoicePrompt({ businessName: 'A & B', smsEnabled: smsStatus !== 'disabled', smsStatus });
    assert.match(prompt, /call nine one one/);
    assert.doesNotMatch(prompt, /call 911/);
    assert.match(prompt, /A &amp; B/);
  }
});
