import { classifyInboundSmsCommand } from '../../src/services/messaging/contactPreference.service.js';
test.each(['stop please','stop sending me texts','Stop sending messages to this number','Please unsubscribe me','I want you to stop texting','Do not send me any more messages'])('opt-out request: %s', text => {
 const result = classifyInboundSmsCommand(text);
 console.log('CONSENT_PROBE', JSON.stringify({text,result}));
 expect(result.action).toBe('opt_out');
});
test.each(['Yes','Do not stop texting me','How do I opt out?'])('ordinary message: %s', text => {expect(classifyInboundSmsCommand(text).handled).toBe(false);});
test('provider START remains authoritative',()=>{expect(classifyInboundSmsCommand('YES',{twilioOptOutType:'START'}).action).toBe('opt_in');});
