import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const resources = new Map([['appointment','Appointment'],['conversation','Conversation'],['alert','Alert'],['recoverycase','RecoveryCase'],['recoveryevent','RecoveryEvent'],['lead','Lead']]);
const mutations = new Set(['save','create','insertOne','insertMany','updateOne','updateMany','findOneAndUpdate','findByIdAndUpdate','replaceOne','findOneAndReplace','bulkWrite','deleteOne','deleteMany','findOneAndDelete','findByIdAndDelete']);
const transitionNames = /^(?:saveBookingDocument|applyBookingStateTransition|applyBookingStateFields|saveBookingTransition|applyBookingEvent|applyAppointmentBookingTransition|bookingTransitionFields|bookingStateFields|commitRequestBookingTransition|persistBookingDocument|persistBookingUpdate|saveRequestBookingDocument|requestStateWrite)$/;
const protectedPath = value => /^(?:bookingState|conversationMemory|orchestration|lifecycle)(?:\.|$)|(?:^|\.)(?:status|reviewStatus|staffReview|resolvedAt|acknowledgedAt|actionRequired)(?:\.|$)/.test(value);
const central = file => file.startsWith('src/services/stateTransitions/') || /src\/services\/(?:booking\/(?:requestBookingState|bookingTurnState\.repository|appointmentBookingTransition\.repository|requestBookingPersistence|requestStateTransaction|intakeHoldTransition\.repository)|scheduling\/reschedule\/(?:finalize|recovery))/.test(file);
const ignored = file => /(?:^|\/)(?:__tests__|__mocks__|fixtures)(?:\/|$)|\.(?:test|spec)\./.test(file);
function filesAt(folder) {
  return fs.readdirSync(folder,{withFileTypes:true}).flatMap(entry => {
    const file=path.join(folder,entry.name);
    return entry.isDirectory() ? ignored(file) ? [] : filesAt(file) : /\.[cm]?jsx?$/.test(file)&&!ignored(file)?[file]:[];
  });
}
function literal(node) { return node?.type==='StringLiteral'?node.value:node?.type==='Identifier'?node.name:''; }
function unwrap(node) { return node?.type==='AwaitExpression'?unwrap(node.argument):node; }
function memberPath(node) {
  if(node?.type==='Identifier')return node.name;
  if(['MemberExpression','OptionalMemberExpression'].includes(node?.type))return `${memberPath(node.object)}.${literal(node.property)}`;
  return '';
}
function nearestName(p) {
  const fn=p.getFunctionParent();
  if(!fn)return '<module>';
  return fn.node.id?.name||fn.node.key?.name||fn.parentPath.node.id?.name||fn.parentPath.node.key?.name||'<callback>';
}
function authority(node,p,file,seen=new Set()) {
  node=unwrap(node);if(!node)return null;
  if(node.type==='ThisExpression')return resources.get(path.basename(file,'.js').toLowerCase())||null;
  if(node.type==='CallExpression')return authority(node.callee.object,p,file,seen);
  if(node.type==='MemberExpression') {
    const name=String(literal(node.property)).toLowerCase();
    if(resources.has(name))return resources.get(name);
    if(name==='model'&&/src\/(?:db\/repositories|services\/stateTransitions)/.test(file))return 'DynamicTenantRecord';
    return authority(node.object,p,file,seen);
  }
  if(node.type!=='Identifier')return null;
  const name=node.name, key=name.toLowerCase();
  if(resources.has(key))return resources.get(key);
  if(/^(?:original|replacement|existingReplacement|storedAppointment|existingAppointment)$/.test(name)&&/scheduling|booking|appointment/i.test(file))return 'Appointment';
  if(/^(?:activeConversation|currentConversation|latestConversation)$/.test(name))return 'Conversation';
  if(/^(?:review|canonical|reviewAlert)$/.test(name)&&/request|alert|intervention|review/i.test(file))return 'Alert';
  if(seen.has(name))return null;seen.add(name);
  const binding=p.scope.getBinding(name);
  if(binding?.path.isImportDefaultSpecifier()) {
    const source=binding.path.parent.source?.value||'';
    const model=source.match(/\/models\/(appointment|conversation|alert|recoveryCase|lead)\.js$/)?.[1];
    if(model)return resources.get(model.toLowerCase());
  }
  if(name==='model'&&/src\/(?:db\/repositories|services\/stateTransitions)/.test(file))return 'DynamicTenantRecord';
  if(binding?.path.isVariableDeclarator())return authority(binding.path.node.init,binding.path,file,seen);
  if(name==='model'&&file.endsWith('/requestStateTransaction.service.js'))return 'RegisteredStateRecord';
  return null;
}
function keysIn(node) {
  const keys=[];
  const visit=value=>{if(!value||typeof value!=='object')return;
    if(value.type==='ObjectProperty')keys.push(literal(value.key));
    for(const [key,child]of Object.entries(value))if(!['loc','start','end','tokens','comments'].includes(key)){
      if(Array.isArray(child))child.forEach(visit);else if(child&&typeof child==='object')visit(child);
    }};
  visit(node);return [...new Set(keys.filter(protectedPath))].sort();
}
function metadata(record,source,kind,file,name) {
  const guards=[...new Set((source.match(/\b(?:assertDistributedLeaseActive|assertVoiceTurnActive|withDistributedLease|withBookingTransaction|bookingDecisionFilter|saveClaimed|intakeReviewVersion|claimToken|confirmationIntent|idempotencyKey|operationId|valuationVersion|updatedAt|version|session|\$where|__v|createRequestBookingGuard|saveRequestBookingDocument|requestStateWrite|withRequestStateTransaction)\b/g)||[]))].sort();
  const repairs=[...new Set(source.match(/\b(?:repair\w+|tryRepair\w+|reconcile\w+|resolveRescheduleReviews|scheduleAppointmentReminders|scheduleAppointmentChangeNotice)\b/g)||[])].sort();
  const modelWrites=[...source.matchAll(/\b(Appointment|Conversation|Lead|Alert|RecoveryCase)\.(?:updateOne|updateMany|findOneAndUpdate|create|deleteMany)\b/g)].map(match=>match[1]);
  const delegatedWrites=[...source.matchAll(/\bmodel:\s*(Appointment|Conversation|Lead|Alert|RecoveryCase)\b/g)].map(match=>match[1]);
  const documentWrites=[...source.matchAll(/\b(appointment|conversation|lead|alert)\.(?:save|set)\b/g)].map(match=>resources.get(match[1]));
  const updatedRecords=[...new Set([...modelWrites,...delegatedWrites,...documentWrites])].filter(name=>name!==record).sort();
  return { authoritativeRecord:record,
    allowedCommand:{module:file,function:name,mode:central(file)?'transition-layer':'registered-domain-command'},
    versionOrClaim:{kind:kind==='save'?'hydrated-document-session-and-hooks':'source-filter-or-command',evidence:guards,
      review:guards.length?'Guards are recorded from the exact fingerprinted owner; inspect its filter for the full predicate.':'No explicit version/lease evidence in this owner; do not infer concurrency safety.'},
    projectionsAndRepair:{updatedRecords,localRepairCommands:repairs,review:repairs.length?'Repair commands referenced by the fingerprinted owner; downstream behavior remains covered by domain tests.':'No local repair path established by this scan; review this owner before changing its effects.'} };
}
/** Conservative AST inventory: saves and dynamic patches are candidates even when fields are not statically known. */
export function scanStateWriters(root) {
  const entries=[];
  for(const file of filesAt(path.join(root,'src')).sort()) {
    const relative=path.relative(root,file).split(path.sep).join('/');
    const source=fs.readFileSync(file,'utf8');
    const ast=parse(source,{sourceType:'unambiguous',plugins:['jsx','importAttributes']});
    const ordinals=new Map();
    const importSha256=digest(ast.program.body.filter(node=>node.type==='ImportDeclaration'||node.source).map(node=>source.slice(node.start,node.end)).join('\n'));
    const add=(p,record,kind,fields,predicateNode=null)=>{
      const name=nearestName(p),fn=p.getFunctionParent()?.node||ast.program;
      const owner=source.slice(fn.start,fn.end),key=`${relative}#${name}#${kind}`,ordinal=(ordinals.get(key)||0)+1;
      ordinals.set(key,ordinal);
      entries.push({id:`${key}#${ordinal}`,file:relative,line:p.node.loc.start.line,kind,fields,
        writerSha256:digest(source.slice(p.node.start,p.node.end)),ownerSha256:digest(owner),importSha256,
        predicateSource: predicateNode?source.slice(predicateNode.start,predicateNode.end):/^(?:update|find|replace|delete)/.test(kind)&&p.node.arguments?.[0]?source.slice(p.node.arguments[0].start,p.node.arguments[0].end):null,
        ...metadata(record,owner,kind,relative,name)});
    };
    const importedTransitions = new Set(ast.program.body.filter(node => node.type === 'ImportDeclaration' &&
      /(?:^|\/)stateTransitions\//.test(node.source.value)).flatMap(node => node.specifiers.map(specifier => specifier.local.name)));
    const visitCall = p => {
        const node=p.node,name=literal(node.callee.property)||literal(node.callee);
        if(transitionNames.test(name) || importedTransitions.has(node.callee.name) || importedTransitions.has(node.callee.object?.name)) {
          const properties=node.arguments[0]?.type==='ObjectExpression'?node.arguments[0].properties:[];
          const value=key=>properties.find(property=>literal(property.key)===key)?.value;
          const record=authority(value('model')||value('document')||node.arguments[0],p,relative)||
            (importedTransitions.has(node.callee.name) ? 'RegisteredStateRecord' : 'Conversation');
          add(p,record,'transition-command',[name,...keysIn(value('changes'))],value('filter'));return;
        }
        if(!mutations.has(name)&&name!=='set'&&name!=='assign'&&!node.callee.computed)return;
        const target=name==='assign'?node.arguments[0]:node.callee.object;
        const record=authority(target,p,relative)||(name==='save'?'DynamicDocument':null);
        const fields=keysIn(name==='save'?null:node.arguments[name==='assign'?1:name==='set'?0:1]);
        if(name==='set'&&node.arguments[0]?.type==='StringLiteral'&&protectedPath(node.arguments[0].value))fields.push(node.arguments[0].value);
        if(record&&(mutations.has(name)||name==='set'||fields.length||node.callee.computed))add(p,record,node.callee.computed&&!mutations.has(name)?'dynamic-method':name,[...new Set(fields)].sort());
    };
    traverse(ast,{
      CallExpression: visitCall,
      OptionalCallExpression: visitCall,
      MemberExpression(p){
        const name=literal(p.node.property);
        if(!mutations.has(name)||(p.parentPath.isCallExpression()||p.parentPath.isOptionalCallExpression())&&p.parentPath.node.callee===p.node)return;
        const record=authority(p.node.object,p,relative);
        if(record)add(p,record,p.parentPath.isUnaryExpression({operator:'typeof'})?'capability-check':'write-capability-reference',[name]);
      },
      AssignmentExpression(p){
        const target=p.node.left;if(target.type!=='MemberExpression')return;
        const trail=memberPath(target),parts=trail.split('.');
        const field=parts.slice(1).join('.');
        if(!protectedPath(field))return;
        const intrinsic=/^(?:bookingState|conversationMemory|orchestration|lifecycle)(?:\.|$)/.test(field)?'Conversation':null;
        const record=intrinsic||authority(target.object,p,relative);
        if(record)add(p,record,'assignment',[field]);
      },
    });
  }
  return entries;
}

export function verifyStateWriters(actual,inventory) {
  const expected=new Map(inventory.writers.map(row=>[row.id,row])),failures=[];
  for(const writer of actual) {
    if (!central(writer.file) && !['transition-command', 'capability-check'].includes(writer.kind))
      failures.push(`State writer bypasses centralized transitions: ${writer.id}`);
    const known=expected.get(writer.id);
    if(!known){failures.push(`Unregistered state writer (transition bypass): ${writer.id}`);continue;}
    expected.delete(writer.id);
    if(known.writerSha256!==writer.writerSha256||known.ownerSha256!==writer.ownerSha256||known.importSha256!==writer.importSha256||known.authoritativeRecord!==writer.authoritativeRecord)
      failures.push(`State writer or its owning guard changed without inventory review: ${writer.id}`);
    for(const field of ['authoritativeRecord','allowedCommand','versionOrClaim','projectionsAndRepair'])
      if(!known[field])failures.push(`Missing ${field}: ${writer.id}`);
  }
  for(const id of expected.keys())failures.push(`Retired state writer remains in inventory: ${id}`);
  if(failures.length)throw Error(failures.join('\n'));
  return {writers:actual.length,rawDomainWriters:actual.filter(x=>!central(x.file)&&!['transition-command','capability-check'].includes(x.kind)).length,transitionCalls:actual.filter(x=>x.kind==='transition-command').length,capabilityChecks:actual.filter(x=>x.kind==='capability-check').length};
}

/** Existing registrations may migrate; new durable primitives belong in the transition layer. */
export function reviewStateWriterInventory(writers) {
  const bypasses = writers.filter(writer =>
    writer.allowedCommand.mode !== 'transition-layer' && !['transition-command', 'capability-check'].includes(writer.kind));
  if (bypasses.length) throw Error('New writers bypass transition functions; inventory regeneration cannot approve them:\n' +
    bypasses.map(writer => writer.id).join('\n'));
  return writers;
}
function main() {
  const args=process.argv.slice(2),root=path.resolve(args.includes('--root')?args[args.indexOf('--root')+1]:path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
  const target=path.join(root,'contracts/state-writers.json'),writers=scanStateWriters(root);
  if(args.includes('--write')) {
    reviewStateWriterInventory(writers, fs.existsSync(target) ? JSON.parse(fs.readFileSync(target,'utf8')) : null);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,JSON.stringify({schemaVersion:1,
      policy:'Every detected writer and its complete owning function and imports are reviewed together. Dynamic tenant writes, complete document saves and extracted write capabilities are conservatively inventoried. Registration is not proof of tenant/concurrency correctness.',
      limitations:['JavaScript dynamic dispatch and caller-bound models require manual review of the recorded owner; the scan is a conservative source inventory, not a whole-program proof.','Empty local repair/claim evidence is an explicit audit gap, not an assurance that recovery or concurrency fencing exists.'],
      writers},null,2)+'\n');
    console.log(`Wrote ${writers.length} state-writer entries.`);
  } else {
    console.log('PASS state-writer inventory',verifyStateWriters(writers,JSON.parse(fs.readFileSync(target,'utf8'))));
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
