import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
const traverse = traverseModule.default || traverseModule;
const parseSource = source => parse(source, { sourceType: 'unambiguous' });
const transient = new Set(['start', 'end', 'loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments']);
const canonical = node => JSON.stringify(node, (key, value) => transient.has(key) ? undefined : value);
const expression = source => parseSource(`(${source})`).program.body[0].expression;
const digest = source => crypto.createHash('sha256').update(canonical(parseSource(source))).digest('hex');

function readCommand(root, target, name, cache) {
  if (!cache.has(target)) cache.set(target, parseSource(fs.readFileSync(path.join(root, target), 'utf8')));
  const declaration = cache.get(target).program.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === name)?.declaration;
  assert.ok(declaration, `Missing transition ${target}#${name}`);
  assert.equal(declaration.async, false, `${name} must preserve synchronous query construction`);
  assert.equal(declaration.body.body.length, 1, `${name} must preserve the relocated expression`);
  assert.equal(declaration.body.body[0].type, 'ReturnStatement');
  return declaration;
}

/** A source-level behavior pin: restore every moved expression and compare the whole owning file's AST.
 * This preserves branch/guard order as well as the exact mutation, without relying on a Git checkout at test time. */
export function verifyStateTransitionMigration(root) {
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'contracts/state-transition-migration.json'), 'utf8'));
  const cache = new Map();
  let commands = 0;
  for (const file of contract.files) {
    const source = fs.readFileSync(path.join(root, file.file), 'utf8');
    const ast = parseSource(source);
    const replacements = [];
    const remaining = [...file.commands];
    const imports = new Map();
    for (const node of ast.program.body.filter(node => node.type === 'ImportDeclaration' && /(?:^|\/)stateTransitions\//.test(node.source.value))) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.file), node.source.value));
      node.specifiers.forEach(specifier => imports.set(specifier.local.name, { target, exported: specifier.imported?.name }));
      replacements.push({ start: node.start, end: node.end, text: '' });
    }
    traverse(ast, { CallExpression(p) {
      const binding = imports.get(p.node.callee.name);
      if (!binding) return;
      const index = remaining.findIndex(command => command.name === binding.exported && command.target === binding.target && canonical(expression(command.call)) === canonical(p.node));
      assert.ok(index >= 0, `Unreviewed transition call in ${file.file}:${p.node.loc.start.line}`);
      const [command] = remaining.splice(index, 1);
      if (['saveStateDocument', 'saveOptionalStateDocument'].includes(command.name)) {
        const declaration = readCommand(root, command.target, command.name, cache);
        const optional = command.name === 'saveOptionalStateDocument' ? '?.' : '';
        const expected = parseSource(`function ${command.name}(document, ...options) { return document.save${optional}(...options); }`).program.body[0];
        assert.equal(canonical(declaration), canonical(expected), `Changed native document-save boundary: ${command.name}`);
      } else {
        const declaration = readCommand(root, command.target, command.name, cache);
        assert.equal(canonical(declaration.body.body[0].argument), canonical(expression(command.expression)), `Changed transition expression: ${command.name}`);
        const expectedParameters = expression(command.call).arguments[0].properties.map(property => property.key.name);
        assert.deepEqual(declaration.params[0]?.properties.map(property => property.key.name), expectedParameters, `Changed capabilities: ${command.name}`);
      }
      replacements.push({ start: p.node.start, end: p.node.end, text: `(${command.expression})` });
      commands += 1;
    } });
    assert.equal(remaining.length, 0, `Missing migrated commands: ${file.file}`);
    let restored = source;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) restored = restored.slice(0, replacement.start) + replacement.text + restored.slice(replacement.end);
    assert.equal(digest(restored), file.baselineAstSha256, `Changed decision guards/order outside the migration: ${file.file}`);
  }
  return { files: contract.files.length, commandCalls: commands };
}
