import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyStateTransitionMigration } from '../scripts/verify-state-transition-migration.mjs';
const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t, caller = 'src/services/booking/intakeReview.service.js') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-transition-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const contract = JSON.parse(fs.readFileSync(path.join(repository, 'contracts/state-transition-migration.json'), 'utf8'));
  contract.files = contract.files.filter(file => file.file === caller);
  const paths = ['contracts/state-transition-migration.json', ...contract.files.flatMap(file => [file.file, ...file.commands.map(command => command.target)])];
  for (const relative of new Set(paths)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.copyFileSync(path.join(repository, relative), path.join(root, relative));
  }
  fs.writeFileSync(path.join(root, paths[0]), JSON.stringify(contract));
  return { root, file: contract.files[0].file, target: contract.files[0].commands[0].target };
}
test('all migrated callers reconstruct the complete baseline AST, including decision guards and ordering', () => {
  assert.deepEqual(verifyStateTransitionMigration(repository), { files: 96, commandCalls: 270 });
});
test('changing a centralized tenant predicate fails the preservation contract', t => {
  const f = fixture(t), target = path.join(f.root, f.target);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('business: business._id, customerName:', 'business: lead._id, customerName:'));
  assert.throws(() => verifyStateTransitionMigration(f.root), /Changed transition expression/);
});
test('removing an outer concurrency guard fails even if the moved writes are identical', t => {
  const f = fixture(t), target = path.join(f.root, f.file);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('assertDistributedLeaseActive();', 'void 0;'));
  assert.throws(() => verifyStateTransitionMigration(f.root), /Changed decision guards\/order/);
});
test('an added side effect in a transition fails the preservation contract', t => {
  const f = fixture(t), target = path.join(f.root, f.target);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('return (Lead.updateOne', 'console.log("unreviewed effect"); return (Lead.updateOne'));
  assert.throws(() => verifyStateTransitionMigration(f.root), /must preserve the relocated expression/);
});

test('wrapping a native document-save promise fails the preservation contract', t => {
  const f = fixture(t, 'src/controllers/auth/Registration.js'), target = path.join(f.root, f.target);
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('export function saveStateDocument', 'export async function saveStateDocument'));
  assert.throws(() => verifyStateTransitionMigration(f.root), /must preserve synchronous query construction/);
});

test('the 13 explicitly revised callers have checked-in behavioral evidence', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(repository, 'contracts/state-transition-migration.json'), 'utf8'));
  assert.equal(contract.behaviorCorrections.length, 13);
  assert.equal(new Set(contract.behaviorCorrections.map(entry => entry.file)).size, 13);
  for (const entry of contract.behaviorCorrections) {
    assert.ok(entry.reason && entry.tests.length);
    assert.ok(fs.existsSync(path.join(repository, entry.file)), entry.file);
    for (const evidence of entry.tests) assert.ok(fs.existsSync(path.join(repository, evidence)), evidence);
  }
});
