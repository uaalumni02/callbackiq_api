#!/usr/bin/env node
/** MeekCall Stage 3: fail-closed architectural boundaries for the new modules.
 * This is a focused non-regression check, not a correctness or production certificate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const role = fs.existsSync(path.join(root, 'src', 'services', 'booking', 'bookingStateMachine.service.js')) ? 'api' : 'frontend';
const api = [
  ['src/services/booking/bookingFixedResult.policy.js', ['fixedResult'], ['src/services/booking/bookingTurnPreflight.service.js', 'src/services/booking/bookingConfirmationTurn.service.js']],
  ['src/services/scheduling/appointmentAttribution.repository.js', ['resolveAppointmentAttribution'], ['src/services/scheduling/appointment.service.js']],
];
const frontend = [
  ['src/features/appointments/createAppointmentCustomerContactAction.js', ['createAppointmentCustomerContactAction'], ['src/pages/Appointments.js']],
  ['src/features/appointments/createRequestedRescheduleDecisionAction.js', ['createRequestedRescheduleDecisionAction'], ['src/pages/Appointments.js']],
  ['src/features/appointments/createStaffRescheduleAction.js', ['createStaffRescheduleAction'], ['src/pages/Appointments.js']],
  ['src/features/appointments/createAppointmentOutcomeActions.js', ['createAppointmentOutcomeActions'], ['src/pages/Appointments.js']],
];
const modules = role === 'api' ? api : frontend;
const problems = [];
const content = f => fs.readFileSync(path.join(root, f), 'utf8');
const currentFiles = new Map();
for (const [file, exports, consumers] of modules) {
  if (!fs.existsSync(path.join(root, file))) { problems.push(`Missing ${file}`); continue; }
  const s = content(file);
  if (Buffer.byteLength(s) > 30_000) problems.push(`Stage 3 module is too large: ${file}`);
  for (const symbol of exports) {
    if (!new RegExp(`\\bexport\\s+const\\s+${symbol}\\b`).test(s)) problems.push(`Missing export ${symbol} in ${file}`);
    for (const parent of consumers) if (!content(parent).includes(symbol)) problems.push(`Missing consumer ${symbol} in ${parent}`);
  }
  if (role === 'frontend' && /(?:from|require\()\s*['"][^'"]*(?:\/pages\/|\/controllers\/|\/db\/|mongoose|stripe|twilio)/i.test(s)) problems.push(`Frontend feature imports forbidden layer: ${file}`);
  if (file.endsWith('.policy.js') && /(?:from|require\()\s*['"][^'"]*(?:\/db\/|\/models\/|\/routes\/|\/controllers\/|mongoose|stripe|twilio)/i.test(s)) problems.push(`Policy imports infrastructure: ${file}`);
  currentFiles.set(file, s);
}
// Resolve all local imports of new modules, including cross-import cycles. Existing
// legacy cycles are not grandfathered as permission to introduce a new one.
const sources = new Map();
function walk(folder) {
  if (!fs.existsSync(folder)) return;
  for (const entry of fs.readdirSync(folder, {withFileTypes:true})) {
    const f = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(f);
    else if (/\.(?:js|jsx|mjs|cjs)$/.test(entry.name)) sources.set(path.relative(root, f).split(path.sep).join('/'), fs.readFileSync(f,'utf8'));
  }
}
walk(path.join(root, 'src'));
const imports = new Map();
for (const [f,s] of sources) {
  const deps = [];
  const pattern = /(?:\bimport\s+(?:[\s\S]{0,250}?\bfrom\s*)?|\bexport\s+[^;\n]{0,250}?\bfrom\s*|\brequire\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const m of s.matchAll(pattern)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(f),m[1]));
    const candidate = [base,base+'.js',base+'.jsx',base+'.mjs',base+'/index.js'].find(x=>sources.has(x));
    if (candidate) deps.push(candidate);
    else if (modules.some(([x])=>x===f)) problems.push(`New module has unresolved local import ${f} -> ${m[1]}`);
  }
  imports.set(f,[...new Set(deps)]);
}
function reachable(now, target, seen=new Set()) {
  if (now===target) return true;
  if (seen.has(now)) return false;
  seen.add(now);
  return (imports.get(now)||[]).some(dep=>reachable(dep,target,seen));
}
for (const [f] of modules) {
  for (const dep of imports.get(f)||[]) if (reachable(dep,f)) problems.push(`New dependency cycle via ${f} -> ${dep}`);
}
if (problems.length) {
  for (const p of problems) console.error('FAIL:', p);
  process.exitCode=1;
} else console.log(`PASS Stage 3 ${role} module boundaries (${modules.length} modules; no new cycles)`);
console.log('This check is static; full behavior, E2E, and production effects require separate verification.');
