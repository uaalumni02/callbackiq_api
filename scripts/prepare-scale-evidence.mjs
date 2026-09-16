// Offline assembly only: never marks operator observations passed.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { REQUIRED_OBSERVATIONS } from '../perf/certificate.mjs';
const source = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const root = path.resolve(process.env.SCALE_EVIDENCE_DIR || `scale-evidence-${Date.now()}`);
// Refuse to overwrite an existing evidence directory.
await fs.mkdir(root, { mode: 0o700 });
const copy = async (file, name) => {
  const bytes = await fs.readFile(file);
  await fs.writeFile(path.join(root, name), bytes, {mode:0o600,flag:'wx'});
  return {path:name,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
};
const evidence = {schemaVersion:2,apiSha:source.apiSha,uiSha:source.uiSha,
  capacityPlan:await copy(source.capacityPlan,'capacity-plan.json'),
  infrastructure:{imageDigest:source.imageDigest,topology:await copy(source.topology,'scale-deployment.json')},
  mixedReports:[],queryReports:[],checks:{}};
for (const [key,prefix] of [['mixedReports','mixed'],['queryReports','query']]) {
  for (const [i,file] of (source[key]||[]).entries()) evidence[key].push(await copy(file,`${prefix}-${i+1}.json`));
}
for (const name of REQUIRED_OBSERVATIONS) {
  const input=source.checks?.[name];
  evidence.checks[name]={passed:input?.passed === true,observedAt:input?.observedAt||'',observedBy:input?.observedBy||'',
    apiSha:input?.apiSha||'',uiSha:input?.uiSha||'',attachment:input?.file?await copy(input.file,`${name}.evidence`):{path:'',sha256:''}};
}
await fs.writeFile(path.join(root,'acceptance.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log(JSON.stringify({directory:root,status:'assembled-not-certified',next:'SCALE_EVIDENCE_DIR=<directory> npm run verify:scale-certificate'}));
