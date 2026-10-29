#!/usr/bin/env node
// Read-only non-regression guard; not a substitute for functional tests.
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const cfg=JSON.parse(fs.readFileSync(path.join(root,'config/maintainability-baseline.json'),'utf8'));
const problems=[];
function walk(folder){if(!fs.existsSync(path.join(root,folder)))return [];return fs.readdirSync(path.join(root,folder),{withFileTypes:true}).flatMap(entry=>{const p=path.posix.join(folder,entry.name);return entry.isDirectory()?walk(p):entry.isFile()?[p]:[];});}
let oversized=0;
for(const file of [...walk('src'),...walk('tools')]){
 const isCode=file.startsWith('src/')&&(file.endsWith('.js')||file.endsWith('.jsx'))&&!file.includes('/__tests__/')&&!file.includes('/tests/')&&!file.includes('/fixtures/')&&!file.includes('.test.')&&!file.includes('.spec.');
 if(isCode){const size=fs.statSync(path.join(root,file)).size;if(size>cfg.newProductionFileLimitBytes){oversized++;const budget=cfg.oversizedModules[file];if(budget===undefined)problems.push('New oversized source: '+file);else if(size>budget+cfg.allowedGrowthBytes)problems.push('Oversized module regressed: '+file);}}
 if((file.startsWith('tools/api_overlay/')||file.startsWith('tools/frontend_overlay/'))&&!cfg.allowedLegacyOverlays.includes(file))problems.push('New deprecated overlay: '+file);
}
for(const [file,forbidden] of Object.entries(cfg.pureModuleBoundaries||{})){const abs=path.join(root,file);if(!fs.existsSync(abs)){problems.push('Missing pure module: '+file);continue;}const content=fs.readFileSync(abs,'utf8');for(const token of forbidden)if(content.includes(token))problems.push('Dependency boundary violated: '+file+' -> '+token);}
if(problems.length){console.error('FAIL maintainability ratchet: '+problems.length);for(const p of problems)console.error(' - '+p);process.exitCode=1;}else console.log('PASS maintainability ratchet: '+oversized+' grandfathered large modules bounded, deprecated overlays frozen.');
