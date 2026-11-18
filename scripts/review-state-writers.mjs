import fs from 'node:fs';
const inventory = JSON.parse(fs.readFileSync('contracts/state-writers.json', 'utf8'));
const classify = row => {
  if (row.kind === 'capability-check') return 'capability-inspection';
  if (row.kind === 'assignment' || row.kind === 'set') return 'staged-fields-with-persistence-owner';
  if (row.kind === 'transition-command') return 'delegated-command-with-recorded-owner';
  if (/appointmentOwnership|documentFence/.test(row.file)) return 'runtime-document-fence';
  if (/rescheduleCompensation/.test(row.file)) return 'durable-compensation';
  if (/accountRecords/.test(row.file) && /ResetPassword/.test(row.id)) return 'atomic-reset-token-consumption';
  if (['save', 'create', 'insertMany'].includes(row.kind)) return 'model-persistence-and-unique-index-contract';
  return 'atomic-query-with-recorded-filter';
};
const evidence = {
  Appointment: 'appointmentOwnership schema fences; confirmation intent predicates; reschedule claim/fingerprint; compensation retry',
  Conversation: 'documentFence saves/query versions; requestBookingPersistence decision predicates; appointment-link projection ownership',
  Lead: 'documentFence saves/query versions; tenantRepository scope; valuationVersion and booking projection predicates',
  Alert: 'recorded tenant/id and delivery claim predicates; alert/intervention repair owners',
  RecoveryCase: 'recorded coordinator transition owner and lease predicates',
  RecoveryEvent: 'recorded recovery event identity and uniqueness',
};
const rows = inventory.writers.map(row => ({ id: row.id, owner: row.allowedCommand, sourceFingerprint: row.ownerSha256,
  authority: row.authoritativeRecord, disposition: classify(row),
  recordedPredicate: row.predicateSource, localClaimEvidence: row.versionOrClaim.evidence,
  enforcement: evidence[row.authoritativeRecord] || 'Dispatch/capability remains bound by the recorded owner; inspect its model and caller. Registration is not proof of safety.',
}));
const counts = rows.reduce((result, row) => ({ ...result, [row.disposition]: (result[row.disposition] || 0) + 1 }), {});
const report = { baseline: '55362b127cc4a72453ca96e995fe54bea95c1333', total: rows.length, counts,
  reviewedRuntimeBypasses: ['Conversation SMS snapshot bulk writes explicitly increment stateVersion; the other runtime bulk writers target unprotected bookkeeping/transcript models.'],
  limitations: ['This is a complete disposition index of the detected writers, not a whole-program security proof.',
    'Generic injected capabilities and dynamic documents still require the recorded owner contract; a missing local predicate does not become a proven guard.',
    'Native collection operations, new bulk operations and model middleware removal must receive explicit review.',
    'Externally accepted effects cannot be rolled back by a MongoDB transaction; compensation/repair evidence must remain durable.'],
  writers: rows };
console.log(JSON.stringify(report, null, 2));
