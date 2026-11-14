#!/usr/bin/env node
// Read-only structural signals; counts do not establish correctness or readiness.
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const role = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === 'callbackiq_api' ? 'api' : 'frontend';
const definitions = role === 'api' ? [
  ['Booking', 'src/services/booking/bookingStateMachine.service.js', ['src/services/booking']],
  ['Appointments', 'src/services/scheduling/appointment.service.js', ['src/services/scheduling']],
  ['Database facade', 'src/db/db.js', ['src/db/repositories']],
  ['SMS processing', 'src/services/messaging/inboundSmsJobProcessor.service.js', ['src/services/messaging']],
  ['Admin reporting', 'src/services/admin/founderReporting.service.js', ['src/services/admin']],
] : [
  ['Leads', 'src/pages/Leads.js', ['src/features/leads', 'src/lib/opportunityValue.js']],
  ['Appointments', 'src/pages/Appointments.js', ['src/features/appointments', 'src/lib/appointmentPageModel.js']],
  ['Billing', 'src/pages/Billing.js', ['src/features/billing', 'src/lib/billingPageModel.js']],
  ['Conversations', 'src/pages/Conversations.js', ['src/features/conversations', 'src/lib/conversationPagePolicy.js']],
];
function sources(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) throw Error(`Missing expected hotspot ${relative}`);
  if (fs.statSync(file).isDirectory()) {
    if (['__tests__', '__mocks__', 'fixtures'].includes(path.basename(file))) return [];
    return fs.readdirSync(file).sort().flatMap(name => sources(path.posix.join(relative, name)));
  }
  return /\.[cm]?jsx?$/.test(relative) && !/\.(test|spec)\./.test(relative) ? [relative] : [];
}
const count = (text, regexp) => (text.match(regexp) || []).length;
function measure(file) {
  const s = fs.readFileSync(path.join(root, file), 'utf8');
  return { name: file, file, bytes: Buffer.byteLength(s), lines: s.trimEnd().split('\n').length,
    importDeclarations: count(s, /^import\s/gm), awaitExpressions: count(s, /\bawait\s/g),
    reactStateHooks: count(s, /\buseState\(/g), reactEffectHooks: count(s, /\buseEffect\(/g),
    reactApiCalls: count(s, /\bapiFetch\(/g), mongooseSaveCalls: count(s, /\.save\(/g) };
}
const groups = definitions.map(([name, entry, collaborators]) => ({ name, entry,
  scope: [entry, ...collaborators], files: [...new Set([entry, ...collaborators].flatMap(sources))] }));
const metrics = [...new Set(groups.flatMap(group => group.files))].sort().map(measure);
const byFile = new Map(metrics.map(row => [row.file, row]));
for (const group of groups) {
  group.totals = Object.fromEntries(Object.keys(metrics[0]).filter(key => typeof metrics[0][key] === 'number')
    .map(key => [key, group.files.reduce((total, file) => total + byFile.get(file)[key], 0)]));
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ role, generatedFor: 'working-tree', groups, metrics }, null, 2));
else {
  console.log(`# MeekCall maintainability hotspots: ${role}`);
  console.log('Counts include each entry point and its listed feature collaborators. Tests/fixtures are excluded.');
  console.log('Groups may overlap; do not sum them into a repository total. These are not quality scores.');
  console.log('| Feature | Files | KiB | Lines | Imports | await | useState | apiFetch | save |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const { name, files, totals: m } of groups) {
    console.log(`| ${name} | ${files.length} | ${(m.bytes / 1024).toFixed(1)} | ${m.lines} | ${m.importDeclarations} | ${m.awaitExpressions} | ${m.reactStateHooks} | ${m.reactApiCalls} | ${m.mongooseSaveCalls} |`);
  }
  for (const group of groups) console.log(`\n${group.name}: ${group.scope.join(', ')}`);
  console.log('\nUse --json for the complete per-file inventory. Transaction ordering, effects and state ownership still need manual review.');
}
