const fs=require('node:fs'),path=require('node:path'),parser=require('@babel/parser'),traverse=require('@babel/traverse').default;
const {execFileSync}=require('node:child_process');
const maximum=entry=>typeof entry==='number'?entry:entry?.maxLines;
const legacyKey=key=>key.replace(/@\d+$/,'');
function measure(root){
 const actual={files:{},functions:{}};
 const walk=folder=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
  const file=path.join(folder,entry.name);
  if(entry.isDirectory()){if(!['__tests__','__mocks__','fixtures'].includes(entry.name))walk(file);continue;}
  if(!/\.[cm]?jsx?$/.test(file)||/\.(test|spec)\./.test(file))continue;
  const relative=path.relative(root,file).split(path.sep).join('/'),source=fs.readFileSync(file,'utf8');
  actual.files[relative]=source.trimEnd().split('\n').length;
  const ast=parser.parse(source,{sourceType:'unambiguous',plugins:['jsx','importAttributes']});
  const functions=[],counts=new Map(),seen=new Map();
  traverse(ast,{Function(p){const n=p.node,name=n.id?.name||n.key?.name||p.parentPath.node.id?.name||p.parentPath.node.key?.name||'<callback>';
   functions.push({name,length:n.loc.end.line-n.loc.start.line+1});counts.set(name,(counts.get(name)||0)+1);
  }});
  for(const {name,length} of functions){
   const ordinal=(seen.get(name)||0)+1;seen.set(name,ordinal);
   actual.functions[relative+'#'+name+(counts.get(name)>1?'@'+ordinal:'')]=length;
  }
 }};
 walk(path.join(root,'src'));return actual;
}
function tighten(budget,actual,owner){
 if(!owner || !/^@[\w-]+$/.test(owner))throw new Error('--tighten requires --owner @github-owner');
 for(const [kind,limit] of [['files',budget.fileLimit],['functions',budget.functionLimit]]){
  const next={};
  for(const [name,lines] of Object.entries(actual[kind])){
   if(lines<=limit)continue;
   const previous=budget[kind][name] || (kind==='functions' && budget.schemaVersion!==2?budget[kind][legacyKey(name)]:null);
   if(!maximum(previous) || lines>maximum(previous))throw new Error(`Refusing unapproved growth: ${name} (${lines})`);
   next[name]={maxLines:lines,owner:previous.owner || owner,expiresAtOrBelow:limit,
    reason:'Temporary existing hotspot; remove this allowance as soon as its measured size reaches the standard limit. Behavioral contracts must precede responsibility changes.'};
  }
  budget[kind]=next;
 }
 budget.schemaVersion=2;
 budget.reason='Owned, measured temporary allowances. Growth and new exceptions require separate architecture review; --tighten cannot approve either.';
 return budget;
}
function verify(budget,actual,baseBudget){
 const failures=[];
 for(const [kind,limit] of [['files',budget.fileLimit],['functions',budget.functionLimit]]){
  for(const [name,entry] of Object.entries(budget[kind])){
   const lines=actual[kind][name];
   if(lines===undefined || lines<=limit){failures.push(`${name}: stale exception; remove it.`);continue;}
   if(!entry.owner || entry.expiresAtOrBelow!==limit)failures.push(`${name}: exception requires an owner and expiry condition <= ${limit}.`);
   if(maximum(entry)!==lines)failures.push(`${name}: allowance must equal current measured size ${lines}; use --tighten for reductions.`);
   const prior=baseBudget && (baseBudget[kind][name] || (kind==='functions' && baseBudget.schemaVersion!==2?baseBudget[kind][legacyKey(name)]:null));
   if(baseBudget && (!prior || maximum(entry)>maximum(prior)))failures.push(`${name}: exception was introduced or enlarged relative to the comparison base.`);
  }
  for(const [name,lines] of Object.entries(actual[kind])){
   if(lines>(maximum(budget[kind][name]) || limit))failures.push(`${name}: ${lines} lines exceeds ${maximum(budget[kind][name]) || limit}.`);
  }
 }
 if(failures.length)throw new Error('Complexity budget regressed:\n'+failures.join('\n'));
 return {fileExceptions:Object.keys(budget.files).length,functionExceptions:Object.keys(budget.functions).length};
}
function main(){
 const args=process.argv.slice(2);let root=path.resolve(__dirname,'..'),owner,base=process.env.DIFF_COVERAGE_BASE,shouldTighten=false;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--root' && args[i+1])root=path.resolve(args[++i]);
  else if(args[i]==='--owner' && args[i+1])owner=args[++i];
  else if(args[i]==='--base' && args[i+1])base=args[++i];
  else if(args[i]==='--tighten')shouldTighten=true;else throw new Error(`Unknown option ${args[i]}`);
 }
 const file=path.join(root,'config/complexity-budget.json'),budget=JSON.parse(fs.readFileSync(file)),actual=measure(root);
 if(shouldTighten)fs.writeFileSync(file,JSON.stringify(tighten(budget,actual,owner),null,2)+'\n');
 let previous;
 if(base)try{previous=JSON.parse(execFileSync('git',['show',`${base}:config/complexity-budget.json`],{cwd:root,encoding:'utf8'}));}
 catch{throw new Error('Cannot resolve complexity comparison base.');}
 console.log('PASS: owned complexity budget '+JSON.stringify(verify(budget,actual,previous)));
}
module.exports={measure,tighten,verify};
if(require.main===module){try{main();}catch(error){console.error(error.message);process.exitCode=1;}}
