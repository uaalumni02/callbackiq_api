#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const root = resolve(__dirname, '..');
const config = JSON.parse(readFileSync(resolve(root, 'config/remediation-metrics.json'), 'utf8'));
const args = process.argv.slice(2);
const refIndex = args.indexOf('--ref');
const revision = refIndex < 0 ? null : args[refIndex + 1];
if (refIndex >= 0 && (!revision || revision.startsWith('-'))) throw new Error('--ref needs a Git revision');

function calleeName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'ThisExpression') return 'this';
  if (node?.type === 'Super') return 'super';
  if (node?.type !== 'MemberExpression' && node?.type !== 'OptionalMemberExpression') return null;
  const owner = calleeName(node.object);
  const key = node.computed ? node.property.value : node.property.name;
  return owner && typeof key === 'string' ? `${owner}.${key}` : null;
}

function measure(source) {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['jsx'] });
  const dependencies = new Set();
  const callees = new Set();
  const functions = new Map();
  const scope = (path) => path.getFunctionParent()?.node;

  const registerImport = ({ node }) => {
    if (node.source) dependencies.add(node.source.value);
  };
  const countDecision = (path) => {
    const parent = scope(path);
    if (parent) functions.get(parent).cyclomatic += 1;
  };
  const countCall = (path) => {
    const { callee, arguments: parameters } = path.node;
    if ((callee.type === 'Import' || callee.name === 'require') && parameters[0]?.type === 'StringLiteral') {
      dependencies.add(parameters[0].value);
    }
    const name = calleeName(callee);
    if (!name) return;
    callees.add(name);
    const parent = scope(path);
    if (parent) functions.get(parent).callees.add(name);
  };

  traverse(ast, {
    'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration': registerImport,
    Function: (path) => { functions.set(path.node, { cyclomatic: 1, callees: new Set() }); },
    'CallExpression|OptionalCallExpression|NewExpression': countCall,
    'IfStatement|ConditionalExpression|CatchClause|ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement|LogicalExpression': countDecision,
    SwitchCase: (path) => { if (path.node.test) countDecision(path); },
  });

  const stats = [...functions.values()];
  return {
    moduleImports: dependencies.size,
    fileCallFanOut: callees.size,
    maxFunctionCallFanOut: Math.max(0, ...stats.map((item) => item.callees.size)),
    maxCyclomatic: Math.max(0, ...stats.map((item) => item.cyclomatic)),
  };
}

const values = Object.fromEntries(Object.keys(config.files).map((file) => {
  const source = revision
    ? execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8' })
    : readFileSync(resolve(root, file), 'utf8');
  return [file, measure(source)];
}));

if (!args.includes('--check')) {
  console.log(JSON.stringify(values, null, 2));
} else {
  const failures = [];
  for (const [file, current] of Object.entries(values)) {
    for (const [metric, value] of Object.entries(current)) {
      const limit = config.files[file][metric];
      if (!Number.isInteger(limit) || value > limit) failures.push(`${file} ${metric}: ${value} (limit ${limit})`);
    }
  }
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  } else {
    console.log(`PASS remediation metric limits across ${Object.keys(values).length} hotspots.`);
  }
}
