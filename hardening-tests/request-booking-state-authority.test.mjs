import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyBookingStateTransition, bookingTransitionFields } from '../src/services/booking/requestBookingState.js';

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

const lowLevelOwners = new Map([
  ['services/booking/appointmentBookingTransition.repository.js', new Set(['bookingStateFields'])],
  ['services/booking/requestBookingPersistence.service.js', new Set(['applyBookingStateFields', 'bookingTransitionChanges'])],
]);
const rawHelpers = new Set(['bookingStateFields', 'applyBookingStateFields', 'bookingStateReplacement',
  'replaceBookingState', 'bookingTransitionChanges']);
const ownerImport = (source) => typeof source === 'string' && /(?:^|\/)requestBookingState(?:\.js)?$/.test(source);

function lowLevelImports(source, file) {
  const violations = [];
  const allowed = lowLevelOwners.get(file);
  const report = node => violations.push(node.loc.start.line);
  traverse(parse(source, { sourceType: 'unambiguous' }), {
    ImportDeclaration({ node }) {
      if (!ownerImport(node.source.value)) return;
      for (const specifier of node.specifiers) {
        const name = text(specifier.imported);
        if (specifier.type !== 'ImportSpecifier' || (rawHelpers.has(name) && !allowed?.has(name))) report(specifier);
      }
    },
    'ExportNamedDeclaration|ExportAllDeclaration'({ node }) {
      if (ownerImport(node.source?.value)) report(node);
    },
    CallExpression({ node }) {
      if ((node.callee.type === 'Import' || node.callee.name === 'require') && ownerImport(text(node.arguments[0]))) report(node);
    },
  });
  return violations;
}

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
    if (!entry.isFile() || !/\.[cm]?js$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    const name = relative(root, file);
    if (name === owner) continue;
    const source = readFileSync(file, 'utf8');
    if (source.includes('bookingState')) {
      for (const line of inlineWrites(source)) violations.push(`${name}:${line}`);
    }
    if (source.includes('requestBookingState')) {
      for (const line of lowLevelImports(source, name)) violations.push(`${name}:${line} bypasses named transitions`);
    }
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

test('only booking repositories can import raw state writers', () => {
  const source = [
    "import { bookingStateFields as fields } from './requestBookingState.js'",
    "import * as raw from './requestBookingState.js'",
    "export * from './requestBookingState.js'",
    "const required = require('./requestBookingState.js')",
    "const dynamic = import('./requestBookingState.js')",
    "import { bookingTransitionFields } from './requestBookingState.js'",
  ].join('\n');
  assert.deepEqual(lowLevelImports(source, 'services/staff.service.js'), [1, 2, 3, 4, 5]);
  assert.deepEqual(lowLevelImports(source, 'services/booking/appointmentBookingTransition.repository.js'), [2, 3, 4, 5]);
});

test('named patches own their fields and full replacements are explicit', () => {
  const input = { status: 'booked', appointment: 'unexpected' };
  const fields = {
    'bookingState.offeredSlots': [],
    'bookingState.selectedSlot': null,
    'bookingState.expiresAt': null,
    'bookingState.status': 'collecting_preference',
    'bookingState.lastError': 'offer_expired',
  };
  assert.deepEqual(bookingTransitionFields('offer_expired', input), fields);
  assert.deepEqual(bookingTransitionFields('conversation_lead_relinked'), { bookingState: { status: 'not_started' } });
  assert.throws(() => bookingTransitionFields('unsupported'), TypeError);

  const writes = [];
  const document = {
    set: (path, value) => writes.push([path, value]),
    markModified: path => writes.push([path]),
  };
  applyBookingStateTransition(document, 'offer_expired', input);
  applyBookingStateTransition(document, 'request_withdrawn');
  assert.deepEqual(writes, [...Object.entries(fields), ['bookingState']]);
  assert.deepEqual(document.bookingState, {
    status: 'not_started', appointment: null, offeredSlots: [], selectedSlot: null, expiresAt: null,
  });

  const first = bookingTransitionFields('offer_expired');
  first['bookingState.offeredSlots'].push('transient');
  assert.deepEqual(bookingTransitionFields('offer_expired'), fields);
});
