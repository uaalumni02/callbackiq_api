#!/usr/bin/env node
// Read-only Phase 0 inventory; no database/network access; does not alter CI thresholds.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const root=path.resolve(__dirname,'..');
const argv=process.argv.slice(2);
const jsonOutput = argv.includes('--json');
const walk=p => fs.existsSync(p)?fs.readdirSync(p,{withFileTypes:true}).flatMap(entry=>{
  const full=path.join(p,entry.name);
  return entry.isDirectory()?walk(full):entry.isFile()&&/\.(?:js|jsx|mjs|cjs)$/.test(entry.name)&&!/(?:\.test\.|\.spec\.|\/__tests__\/)/.test(full)?[full]:[];
}):[];
const files=walk(path.join(root,'src'));
const results=[];
for(const full of files){
  const src=fs.readFileSync(full,'utf8');
  const codeLines=src.split('\n').length;
  let imports=0, maxFnLines=0,maxComplexity=0, ternaries=0, states=0, effects=0, moduleAST;
  try { moduleAST=parser.parse(src,{sourceType:'unambiguous',plugins:['jsx','classProperties','classPrivateProperties','classPrivateMethods','dynamicImport']}); }
  catch(e){results.push({file:path.relative(root,full),error:String(e.message).slice(0,150)});continue;}
  traverse(moduleAST,{
    ImportDeclaration(){imports++;},
    ConditionalExpression(){ternaries++;},
    CallExpression(p){const c=p.node.callee;if(c.type==='Identifier'&&c.name==='useState')states++;if(c.type==='Identifier'&&c.name==='useEffect')effects++;},
    Function(p){
      const size=p.node.loc? p.node.loc.end.line-p.node.loc.start.line+1:0;
      maxFnLines=Math.max(maxFnLines,size);
      let complexity=1;
      p.traverse({
        Function(child){child.skip();},
        IfStatement(){complexity++;},ConditionalExpression(){complexity++;},
        ForStatement(){complexity++;},ForInStatement(){complexity++;},ForOfStatement(){complexity++;},
        WhileStatement(){complexity++;},DoWhileStatement(){complexity++;},
        CatchClause(){complexity++;},
        SwitchCase(child){if(child.node.test)complexity++;},
        LogicalExpression(child){if(['&&','||','??'].includes(child.node.operator)) complexity++;},
      });
      maxComplexity=Math.max(maxComplexity,complexity);
    },
  });
  results.push({file:path.relative(root,full),lines:codeLines,imports,ternaries,maxFunctionLines:maxFnLines,maxFunctionComplexityEstimate:maxComplexity,reactStateHooks:states,reactEffectHooks:effects});
}
const hotspots=results.filter(r=>(r.lines||0)>300).sort((a,b)=>b.lines-a.lines);
const report={revision:'working tree (record git rev-parse HEAD separately)',filesMeasured:results.length,filesOver300Lines:hotspots.length,hotspots,method:'Babel AST static complexity estimate; no dynamic/e2e claims'};
if(jsonOutput)console.log(JSON.stringify(report,null,2));
else {console.log(`Measured ${report.filesMeasured} source files; ${report.filesOver300Lines} >300 lines.`);for(const v of hotspots)console.log(`${v.lines}\t${v.imports}\t${v.maxFunctionLines}\t${v.maxFunctionComplexityEstimate}\t${v.file}`);}
