import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyBookingStateFields, bookingStateFields, bookingStateReplacement, replaceBookingState } from '../src/services/booking/requestBookingState.js';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const root = fileURLToPath(new URL('../src/', import.meta.url));
const owner = 'services/booking/requestBookingState.js';
const updateOperators = new Set(['$set', '$unset', '$setOnInsert', '$inc', '$push', '$pull', '$rename']);
const updateMethods = new Set(['update', 'updateOne', 'updateMany', 'findOneAndUpdate',
  'findByIdAndUpdate', 'replaceOne', 'findOneAndReplace']);
const memberMutators = new Set(['push', 'pop', 'splice', 'shift', 'unshift', 'sort', 'reverse', 'fill']);
const text = (node) => node?.value ?? node?.name ?? node?.quasis?.[0]?.value?.cooked;
const bookingPath = (value) => typeof value === 'string' && (value === 'bookingState' || value.startsWith('bookingState.'));
const property = (node) => node?.type === 'MemberExpression' && text(node.property);
const writesBookingMember = (node) => {
  for (let member = node; member?.type === 'MemberExpression'; member = member.object) {
    if (bookingPath(property(member))) return true;
  }
  return false;
};

function inlineWrites(source) {
  const lines = new Set();
  const report = ({ node }) => lines.add(node.loc.start.line);
  traverse(parse(source, { sourceType: 'unambiguous' }), {
    AssignmentExpression(path) {
      if (writesBookingMember(path.node.left)) report(path);
    },
    UpdateExpression(path) {
      if (writesBookingMember(path.node.argument)) report(path);
    },
    UnaryExpression(path) {
      if (path.node.operator === 'delete' && writesBookingMember(path.node.argument)) report(path);
    },
    'CallExpression|OptionalCallExpression'(path) {
      const { callee, arguments: args } = path.node;
      const method = property(callee);
      if (['set', 'markModified'].includes(method) && bookingPath(text(args[0]))) report(path);
      if (memberMutators.has(method) && writesBookingMember(callee.object)) report(path);
      if (method === 'assign' && callee.object.name === 'Object' && writesBookingMember(args[0])) report(path);
    },
    ObjectProperty(path) {
      if (!bookingPath(text(path.node.key))) return;
      const container = path.parentPath.parentPath;
      if (container.isObjectProperty() && updateOperators.has(text(container.node.key))) report(path);
      if (!container.isCallExpression()) return;
      const { callee, arguments: args } = container.node;
      const method = property(callee);
      const position = args.indexOf(path.parentPath.node);
      if (method === 'assign' && callee.object.name === 'Object') report(path);
      if (method === 'set' && position === 0) report(path);
      if (updateMethods.has(method) && (position === 1 || args.length === 1)) report(path);
    },
  });
  return [...lines];
}

test('runtime modules write Conversation booking state through its owner', () => {
  const violations = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const file = join(entry.parentPath, entry.name);
    const name = relative(root, file);
    if (name === owner) continue;
    const source = readFileSync(file, 'utf8');
    if (!source.includes('bookingState')) continue;
    for (const line of inlineWrites(source)) violations.push(`${name}:${line}`);
  }
  assert.deepEqual(violations, []);
});

test('the ownership check catches document, Mongo update and shared patch bypasses', () => {
  assert.deepEqual(inlineWrites([
    "conversation.bookingState = { status: 'booked' }",
    "conversation.bookingState.status = 'booked'",
    "conversation.set(\`bookingState.\${key}\`, value)",
    "Conversation.updateOne(filter, { $set: { 'bookingState.status': 'booked' } })",
    "Object.assign(changes, { 'bookingState.status': 'booked' })",
    "Conversation.findOne({ 'bookingState.status': 'booked' })",
    "Conversation.updateOne(filter, { bookingState: { status: 'booked' } })",
    "conversation.set({ bookingState: { status: 'booked' } })",
    "conversation.bookingState.offeredSlots.splice(0, 1)",
    "Object.assign(conversation.bookingState, { status: 'booked' })",
    "Conversation.updateOne({ 'bookingState.status': 'booked' }, { $set: { status: 'open' } })",
  ].join('\n')), [1, 2, 3, 4, 5, 7, 8, 9, 10]);
});

test('partial updates preserve the existing dotted fields and replacement is explicit', () => {
  const changes = { status: 'collecting_preference', selectedSlot: null, offeredSlots: [] };
  const fields = {
    'bookingState.status': 'collecting_preference',
    'bookingState.selectedSlot': null,
    'bookingState.offeredSlots': [],
  };
  assert.deepEqual(bookingStateFields(changes), fields);
  assert.deepEqual(bookingStateReplacement(changes), { bookingState: changes });

  const writes = [];
  const document = {
    set: (path, value) => writes.push([path, value]),
    markModified: (path) => writes.push([path]),
  };
  applyBookingStateFields(document, changes);
  replaceBookingState(document, changes, { markModified: true });
  assert.deepEqual(writes, [...Object.entries(fields), ['bookingState']]);
  assert.equal(document.bookingState, changes);
  replaceBookingState({}, changes);
  replaceBookingState({}, changes, { markModified: true });
});
