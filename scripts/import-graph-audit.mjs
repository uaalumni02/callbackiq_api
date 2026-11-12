#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const profiles = {
  callbackiq_api: ['src/services/booking/bookingClassification.policy.js',
    'src/services/booking/bookingConversation.repository.js', 'src/db/repositories/userIdentityRepository.js'],
  callbackiq_frontend: ['src/features/billing/createBillingSubscriptionActions.js',
    'src/features/billing/createSupportTicketActions.js', 'src/features/appointments/createSchedulingLeadPrefillEffect.js',
    'src/features/conversations/createManualReplyAction.js'],
};
const code = /\.(?:[cm]?js|jsx|tsx?)$/;
const ignored = new Set(['node_modules','coverage','coverage-full-suite','coverage-diff-release','build','dist','.git','test-results','playwright-report']);
const walk = directory => fs.existsSync(directory)
  ? fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? ignored.has(entry.name) ? [] : walk(path.join(directory, entry.name)) : code.test(entry.name) ? [path.join(directory, entry.name)] : []) : [];
const literal = node => node?.type === 'StringLiteral' ? node.value
  : node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : null;

function sourceFiles(root) {
  if (!fs.existsSync(path.join(root,'.git'))) return walk(root);
  return [...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],
    {cwd:root,encoding:'utf8',maxBuffer:10*1024*1024}).split('\0').filter(Boolean))]
    .filter(file=>code.test(file) && !file.split('/').some(part=>ignored.has(part)))
    .map(file=>path.join(root,file)).filter(file=>fs.existsSync(file));
}

export function importsIn(file) {
  const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'unambiguous', createImportExpressions: true,
    plugins: ['jsx', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])] });
  const result = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration','ImportExpression'].includes(node.type)) {
      const specifier = literal(node.source);
      if (specifier) result.push({ specifier, line: node.loc.start.line, kind: node.type });
    } else if (node.type === 'CallExpression' &&
      (node.callee.type === 'Import' || (node.callee.type === 'Identifier' && node.callee.name === 'require'))) {
      const specifier = literal(node.arguments[0]);
      if (specifier) result.push({ specifier, line: node.loc.start.line, kind: node.callee.type });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object' && value.type) visit(value);
    }
  };
  visit(ast); return result;
}

export function resolveTarget(file, specifier, repository, kind) {
  if (kind === 'Identifier' && repository === 'callbackiq_api') {
    try {return createRequire(file).resolve(specifier);}
    catch (error) {if(specifier.startsWith('.') || specifier.startsWith('/')) throw new Error(`missing target ${specifier}`);throw error;}
  }
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return createRequire(file).resolve(specifier);
  const raw = path.resolve(path.dirname(file), specifier.split(/[?#]/)[0]);
  const candidates = repository === 'callbackiq_api' ? [raw]
    : [raw,...['.js','.jsx','.mjs','.cjs','.ts','.tsx','.json','/index.js','/index.jsx'].map(ext => raw+ext)];
  const target = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!target) throw new Error(`missing target ${specifier}`);
  return target;
}

function pathBack(graph, start, target, visited = new Set()) {
  if (start === target) return [target]; if (visited.has(start)) return null; visited.add(start);
  for (const next of graph.get(start) || []) { const hit = pathBack(graph,next,target,visited); if (hit) return [start,...hit]; }
  return null;
}

export function auditImports(root = process.cwd()) {
  root = path.resolve(root);
  const repository = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).name;
  if (!profiles[repository]) throw new Error(`Unknown repository package: ${repository}`);
  const files = sourceFiles(root), graph = new Map(), failures = [];
  let edges = 0, dynamicImports = 0;
  for (const file of files) {
    const targets = [];
    try {
      for (const dependency of importsIn(file)) {
        try {
          const target = resolveTarget(file,dependency.specifier,repository,dependency.kind);
          if (dependency.specifier.startsWith('.')) { targets.push(target); edges += 1; }
          if (['ImportExpression','Import'].includes(dependency.kind)) dynamicImports += 1;
        } catch (error) { failures.push(`${path.relative(root,file)}:${dependency.line}: ${error.message}`); }
      }
    } catch (error) { failures.push(`${path.relative(root,file)}: ${error.message}`); }
    graph.set(file,[...new Set(targets)]);
  }
  for (const relative of profiles[repository]) {
    const file = path.join(root,relative);
    if (!graph.has(file)) { failures.push(`Missing protected module ${relative}`); continue; }
    for (const target of graph.get(file)) {
      const cycle = pathBack(graph,target,file);
      if (cycle) failures.push(`Protected module cycle: ${[file,...cycle].map(p=>path.relative(root,p)).join(' -> ')}`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return {repository,files:files.length,localImportEdges:edges,literalDynamicImports:dynamicImports};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(auditImports(process.argv[2]),null,2));
    console.log('PASS: static and literal dynamic imports resolve; protected modules remain acyclic'); }
  catch (error) { console.error(error.message); process.exitCode=1; }
}
