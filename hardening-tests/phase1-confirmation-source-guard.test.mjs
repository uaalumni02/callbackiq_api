import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync('src/services/scheduling/commands/confirm-1.js','utf8');
test('commit-boundary logging and isolated reminder intervention are retained', () => {
  assert.match(src, /appointment\.confirm\.post_commit_effect_failed/);
  assert.match(src, /safelyAfterCommit\("reminder_failure_intervention"/);
  assert.match(src, /safelyAfterCommit\("business_socket_event"/);
  assert.match(src, /safelyAfterCommit\("projection_repair"/);
  assert.match(src, /provider\.cancelAppointment/);
  assert.match(src, /await appointment\.save\(\)/);
});
