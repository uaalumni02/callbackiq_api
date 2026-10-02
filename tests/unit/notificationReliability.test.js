import { automationReadiness, markAutomationStarted, markAutomationStopped, markAutomationTick } from '../../src/services/automationReadiness.service.js';
import { emailConfiguration } from '../../src/helpers/email/emailConfiguration.js';
afterEach(() => { markAutomationStopped(); jest.restoreAllMocks(); });
test('API-only roles do not require local automation, but automation roles require actual progress', () => {
 expect(automationReadiness({env:{PROCESS_ROLE:'api'}}).ready).toBe(true);
 expect(automationReadiness({env:{PROCESS_ROLE:'worker-automation'}}).ready).toBe(false);
 jest.spyOn(Date,'now').mockReturnValue(1000000);
 markAutomationStarted(); markAutomationTick(true);
 expect(automationReadiness({env:{PROCESS_ROLE:'worker-automation'},now:1000001}).ready).toBe(true);
 expect(automationReadiness({env:{PROCESS_ROLE:'worker-automation'},now:1120001}).ready).toBe(false);
 markAutomationTick(false);
 expect(automationReadiness({env:{PROCESS_ROLE:'worker-automation'},now:1120001}).ready).toBe(false);
});
test('SMTP is configurable with encryption and Gmail remains compatible', () => {
 expect(emailConfiguration({GMAIL_ADDRESS:'owner@example.test',GMAIL_PASSWORD:'password'})).toMatchObject({configured:true,transport:{service:'gmail'}});
 expect(emailConfiguration({SMTP_HOST:'smtp.example.test',SMTP_USER:'user',SMTP_PASSWORD:'secret',EMAIL_FROM:'hello@example.test'})).toMatchObject({configured:true,from:'hello@example.test',transport:{port:587,secure:false,requireTLS:true}});
 expect(emailConfiguration({SMTP_HOST:'smtp.example.test',SMTP_USER:'user',SMTP_PASSWORD:'secret',SMTP_PORT:'465'}).transport.secure).toBe(true);
 expect(emailConfiguration({SMTP_HOST:'smtp.example.test'}).configured).toBe(false);
});
