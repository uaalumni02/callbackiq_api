import { shouldServeVoiceRelay } from '../../src/config/runtime-environment.js';

test.each(['all', 'api', 'worker', 'worker-sms'])('%s cannot own the voice WebSocket upgrade path', PROCESS_ROLE => {
  expect(shouldServeVoiceRelay({PROCESS_ROLE, VOICE_RELAY_ENABLED: 'true'})).toBe(false);
});
test('only the voice process can enable ConversationRelay', () => {
  expect(shouldServeVoiceRelay({PROCESS_ROLE: 'voice', VOICE_RELAY_ENABLED: 'true'})).toBe(true);
  expect(shouldServeVoiceRelay({PROCESS_ROLE: 'voice', VOICE_RELAY_ENABLED: 'false'})).toBe(false);
});
