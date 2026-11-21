import { shouldServeVoiceRelay } from '../../src/config/runtime-environment.js';

test.each(['api', 'worker', 'worker-sms'])('%s cannot own the voice WebSocket upgrade path', PROCESS_ROLE => {
  expect(shouldServeVoiceRelay({PROCESS_ROLE, VOICE_RELAY_ENABLED: 'true'})).toBe(false);
});
test.each(['all', 'voice'])('%s serves ConversationRelay unless explicitly disabled', PROCESS_ROLE => {
  expect(shouldServeVoiceRelay({PROCESS_ROLE})).toBe(true);
  expect(shouldServeVoiceRelay({PROCESS_ROLE, VOICE_RELAY_ENABLED: 'true'})).toBe(true);
  expect(shouldServeVoiceRelay({PROCESS_ROLE, VOICE_RELAY_ENABLED: 'false'})).toBe(false);
});
test('the default single-process role serves the relay', () => {
  expect(shouldServeVoiceRelay({})).toBe(true);
});
