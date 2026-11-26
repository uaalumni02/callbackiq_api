import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deduplicateV8Branches,distinctBranchLcov,readDistinctBranchLcov} from '../../scripts/normalizeV8Coverage.cjs';
const loc=(column=0)=>({start:{line:1,column},end:{line:1,column:column+1}});
const metadata=(column=0)=>({type:'branch',line:1,loc:loc(column),locations:[loc(column)]});
const fixture=()=>({path:'/synthetic/source.js',statementMap:{0:loc()},s:{0:1},fnMap:{0:{name:'guard',decl:loc(),loc:loc()}},f:{0:1},branchMap:{0:metadata(),1:metadata(),2:metadata(4)},b:{0:[0],1:[0],2:[1]}});
test('M01 duplicate uncovered records remain an uncovered distinct branch',()=>{
 const result=deduplicateV8Branches(fixture());expect(result.duplicates).toBe(1);expect(Object.values(result.coverage.b)).toEqual([[0],[1]]);
 expect(result.coverage.s).toEqual({0:1});expect(result.coverage.f).toEqual({0:1});
});
test('M01 duplicate hits are added without erasing the original evidence',()=>{
 const input=fixture();input.b[0]=[2];input.b[1]=[3];const before=JSON.stringify(input);const result=deduplicateV8Branches(input);
 expect(result.coverage.b[0]).toEqual([5]);expect(JSON.stringify(input)).toBe(before);expect(deduplicateV8Branches(result.coverage).duplicates).toBe(0);
});
test('M01 equal lines with different columns or end locations remain distinct',()=>{
 const input=fixture();input.branchMap[1].loc.end.column=2;input.branchMap[1].locations[0].end.column=2;
 expect(deduplicateV8Branches(input).duplicates).toBe(0);
});
test.each(['if','binary-expr','cond-expr'])('M01 %s instrumentation is never normalized as a V8 singleton',type=>{
 const input=fixture();input.branchMap[0].type=type;input.branchMap[1].type=type;expect(deduplicateV8Branches(input).duplicates).toBe(0);
});
test('M01 multi-location branches and truthiness evidence remain intact',()=>{
 const input=fixture();input.branchMap[0].locations.push(loc(2));input.branchMap[1].locations.push(loc(2));input.b[0]=[0,1];input.b[1]=[1,0];
 expect(deduplicateV8Branches(input).duplicates).toBe(0);input.bT={0:[0,1]};expect(deduplicateV8Branches(input).coverage).toEqual(input);
});
test.each([-1,NaN,Infinity])('M01 invalid counter %p fails closed',value=>{
 const input=fixture();input.b[0]=[value];expect(()=>deduplicateV8Branches(input)).toThrow(TypeError);
});
test('M01 the LCOV view retains uncovered branches and never rewrites raw evidence',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'meekcall-coverage-normalization-'));const dir=path.join(root,'coverage');fs.mkdirSync(dir);const input=fixture();input.path=path.join(root,'src/source.js');
 const rawJson=JSON.stringify({[input.path]:input});const rawLcov='TN:\nSF:src/source.js\nDA:1,1\nBRDA:1,0,0,0\nBRDA:1,1,0,0\nBRDA:1,2,0,1\nBRF:3\nBRH:1\nend_of_record\n';
 fs.writeFileSync(path.join(dir,'coverage-final.json'),rawJson);fs.writeFileSync(path.join(dir,'lcov.info'),rawLcov);
 try {
  const view=readDistinctBranchLcov(root);expect(view).toContain('BRDA:1,0,0,0');expect(view).not.toContain('BRDA:1,1,0,0');expect(view).toContain('BRF:2');expect(view).toContain('BRH:1');
  expect(fs.readFileSync(path.join(dir,'coverage-final.json'),'utf8')).toBe(rawJson);expect(fs.readFileSync(path.join(dir,'lcov.info'),'utf8')).toBe(rawLcov);
  expect(()=>distinctBranchLcov(rawLcov.replace('BRDA:1,0,0,0','BRDA:1,0,0,99'),{[input.path]:input},root)).toThrow(/differ/);
  fs.unlinkSync(path.join(dir,'coverage-final.json'));expect(readDistinctBranchLcov(root)).toBe(rawLcov);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('M01 combining a covered duplicate retains its execution count and an unrelated uncovered point',()=>{
 const root='/synthetic',input=fixture();input.path='/synthetic/source.js';input.b={0:[0],1:[2],2:[0]};
 const raw='SF:source.js\nBRDA:1,0,0,0\nBRDA:1,1,0,2\nBRDA:1,2,0,0\nBRF:3\nBRH:1\nend_of_record\n';
 const result=distinctBranchLcov(raw,{[input.path]:input},root);expect(result.lcov).toContain('BRDA:1,0,0,2');expect(result.lcov).toContain('BRDA:1,2,0,0');expect(result.lcov).toContain('BRF:2');expect(result.lcov).toContain('BRH:1');
 expect(()=>distinctBranchLcov(raw.replace('BRDA:1,2,0,0\n',''),{[input.path]:input},root)).toThrow(/missing/);
});
