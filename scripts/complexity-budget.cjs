const fs=require('node:fs'),path=require('node:path'),parser=require('@babel/parser'),traverse=require('@babel/traverse').default;
const root=path.resolve(__dirname,'..'),budgetFile=path.join(root,'config/complexity-budget.json');
const actual={files:{},functions:{}},failures=[];
function walk(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
 const file=path.join(folder,entry.name);if(entry.isDirectory()){if(!['__tests__','__mocks__','fixtures'].includes(entry.name))walk(file);continue;}
 if(!/\.(js|jsx)$/.test(file)||/\.(test|spec)\./.test(file))continue;
 const relative=path.relative(root,file).split(path.sep).join('/'),source=fs.readFileSync(file,'utf8');
 const lines=source.trimEnd().split('\n').length;actual.files[relative]=lines;
 const ast=parser.parse(source,{sourceType:'unambiguous',plugins:['jsx','importAttributes']});
 traverse(ast,{Function(p){const n=p.node,name=n.id?.name||n.key?.name||p.parentPath.node.id?.name||p.parentPath.node.key?.name||'<callback>';
 const key=relative+'#'+name,length=n.loc.end.line-n.loc.start.line+1;actual.functions[key]=Math.max(actual.functions[key]||0,length);}});
}}
walk(path.join(root,'src'));
if(process.argv.includes('--initialize')){
 if(fs.existsSync(budgetFile))throw new Error('Refusing to overwrite a reviewed complexity budget.');
 const snapshot={fileLimit:400,functionLimit:60,reason:'Reviewed remediation snapshot. Exceptions remain visible; new or enlarged exceptions require review and behavioral evidence.',
 files:Object.fromEntries(Object.entries(actual.files).filter(([,n])=>n>400)),functions:Object.fromEntries(Object.entries(actual.functions).filter(([,n])=>n>60))};
 fs.writeFileSync(budgetFile,JSON.stringify(snapshot,null,2)+'\n');
}else{
 const budget=JSON.parse(fs.readFileSync(budgetFile));
 for(const [name,lines]of Object.entries(actual.files))if(lines>(budget.files[name]||budget.fileLimit))failures.push(name+': '+lines+' lines');
 for(const [name,lines]of Object.entries(actual.functions))if(lines>(budget.functions[name]||budget.functionLimit))failures.push(name+': '+lines+' lines');
 if(failures.length)throw new Error('Complexity budget regressed:\n'+failures.join('\n'));
 console.log('Complexity budget passed; '+Object.keys(budget.files).length+' file and '+Object.keys(budget.functions).length+' function exceptions remain explicit.');
}
