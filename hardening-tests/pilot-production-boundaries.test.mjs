import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');

test('Twilio production webhook signature checks fail closed', () => {
  const s = read('src/middleware/validate-twilio-signature.js');
  assert.match(s, /process\.env\.NODE_ENV === "production"\) return false/);
  assert.match(s, /status\(403\)/);
  assert.match(s, /validateTwilioRequestWithRotation/);
});

test('owner appointment routes retain authentication and subscription gates', () => {
  const s = read('src/routes/appointment.routes.js');
  assert.match(s, /router\.use\(checkAuth, checkSubscription\)/);
  assert.match(s, /AppointmentController\.confirm/);
});

test('business-scoped ownership is checked on appointment operations', () => {
  const s = read('src/controllers/appointment.js');
  assert.match(s, /getOwnedBusiness/);
  assert.match(s, /approvedBy: req\.user\?\.userId/);
});

test('SMS webhook processing uses persisted idempotent work', () => {
  const s = read('src/services/twilioSmsWebhook.service.js');
  assert.match(s, /enqueueInboundSmsJob/);
  assert.match(s, /sendIdempotentInboundSmsReply/);
  assert.match(s, /persistInboundSmsMessage/);
});

test('the maintenance role is not conflated with SMS-only workers', () => {
  const s = read('src/worker.js');
  assert.match(s, /"worker-maintenance"/);
  assert.match(s, /startAppointmentMaintenanceWorker/);
  assert.match(s, /"worker-sms"/);
});

test('unsupported scheduling providers continue to fail closed', () => {
  for (const path of ['src/integrations/scheduling/housecallPro.provider.js', 'src/integrations/scheduling/serviceTitan.provider.js']) {
    const s = read(path);
    assert.match(s, /PROVIDER_NOT_CONFIGURED/);
    assert.match(s, /async createAppointment\(\)/);
  }
});
