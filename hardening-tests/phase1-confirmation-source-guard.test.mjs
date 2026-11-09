import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync('src/services/scheduling/commands/confirm-1.js','utf8');
const legacy = readFileSync('src/services/scheduling/commands/confirmWithoutRecovery.js', 'utf8');
const recovery = readFileSync('src/services/scheduling/appointmentConfirmationRecovery.service.js', 'utf8');
test('commit-boundary logging and isolated reminder intervention are retained', () => {
  assert.match(src, /appointment\.confirm\.post_commit_effect_failed/);
  assert.match(src, /safelyAfterCommit\("reminder_failure_intervention"/);
  assert.match(src, /safelyAfterCommit\("business_socket_event"/);
  assert.match(src, /safelyAfterCommit\("projection_repair"/);
  assert.match(legacy, /provider\.cancelAppointment/);
  assert.match(legacy, /await appointment\.save\(\)/);
  assert.match(recovery, /provider\.cancelAppointment/);
  assert.match(src, /await intent\.begin\([\s\S]*await recovery\.processProvider\(/);
  assert.match(src, /await afterCommit\(confirmed, business, service\)/);
});
