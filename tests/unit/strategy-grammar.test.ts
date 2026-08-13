// The grammar's claims, turned into assertions.
//
// Most of these are ordinary schema tests. Two are not: the walk over the generated JSON
// schema is the structural claim that no field anywhere can name where money goes, and the
// hash tests are the claim that the thing a human approved is the thing that runs. Both would
// pass silently if someone deleted them, so they are named for what they protect.
//
// Run: node --test tests/unit/strategy-grammar.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { Program } from '../../src/strategy/grammar.ts';
import { PROGRAM_SCHEMA, actionVerbs, programHash, validateProgram } from '../../src/strategy/grammar.ts';

const valid: Program = {
  symbol: 'ETH',
  rules: [
    {
      id: 'entry',
      when: { op: 'price_cross_up', ref: { kind: 'drawing', id: 'tl_1' } },
      then: [
        {
          do: 'open',
          side: 'long',
          sizeUsd: 500,
          leverage: 3,
          entry: { type: 'limit', ref: { kind: 'drawing', id: 'tl_1' }, postOnly: true },
        },
        { do: 'set_stop', ref: { kind: 'drawing', id: 'zn_1' } },
      ],
      once: true,
    },
    {
      id: 'exit',
      when: {
        op: 'or',
        of: [
          { op: 'pnl_pct', cmp: 'lt', value: -2 },
          { op: 'elapsed', since: 'entry', cmp: 'gt', seconds: 7200 },
        ],
      },
      then: [{ do: 'close', exit: { type: 'market', maxSlippageBps: 25 } }],
      cooldownSec: 60,
    },
  ],
  invalidate: { op: 'bar_close', timeframeSec: 3600, side: 'below', ref: { kind: 'drawing', id: 'zn_1' } },
};

function clone(p: Program): Program {
  return JSON.parse(JSON.stringify(p)) as Program;
}

test('a valid program round-trips unchanged', () => {
  const r = validateProgram(clone(valid));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.program, valid);
});

test('an unknown key is rejected at every level', () => {
  const cases: Array<[string, unknown]> = [
    ['program', { ...clone(valid), maxLossUsd: 100 }],
    ['rule', { ...clone(valid), rules: [{ ...clone(valid).rules[0], notes: 'hi' }, clone(valid).rules[1]] }],
    [
      'action',
      {
        ...clone(valid),
        rules: [
          { id: 'a', when: { op: 'position', state: 'flat' }, then: [{ do: 'cancel', which: 'all', force: true }] },
        ],
      },
    ],
    [
      'ref',
      {
        ...clone(valid),
        rules: [
          {
            id: 'a',
            when: { op: 'price_above', ref: { kind: 'drawing', id: 'tl_1', chain: 'eth' } },
            then: [{ do: 'notify', text: 'x' }],
          },
        ],
      },
    ],
  ];

  for (const [level, raw] of cases) {
    const r = validateProgram(raw);
    assert.equal(r.ok, false, `an unknown key on a ${level} was accepted`);
  }
});

test('a negative or zero size is rejected', () => {
  for (const sizeUsd of [-500, 0]) {
    const p = clone(valid);
    const open = p.rules[0].then[0];
    assert.equal(open.do, 'open');
    if (open.do !== 'open') return;
    open.sizeUsd = sizeUsd;
    assert.equal(validateProgram(p).ok, false, `sizeUsd ${sizeUsd} was accepted`);
  }
});

test('leverage outside 1..40 is rejected, and so is a fractional one', () => {
  for (const leverage of [0, -3, 41, 100, 2.5]) {
    const p = clone(valid);
    const open = p.rules[0].then[0];
    if (open.do !== 'open') throw new Error('fixture drifted');
    open.leverage = leverage;
    assert.equal(validateProgram(p).ok, false, `leverage ${leverage} was accepted`);
  }
  for (const leverage of [1, 3, 40]) {
    const p = clone(valid);
    const open = p.rules[0].then[0];
    if (open.do !== 'open') throw new Error('fixture drifted');
    open.leverage = leverage;
    assert.equal(validateProgram(p).ok, true, `leverage ${leverage} was refused`);
  }
});

test('two rules cannot share an id', () => {
  const p = clone(valid);
  p.rules[1].id = p.rules[0].id;
  const r = validateProgram(p);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('duplicate rule id')), r.errors.join(' | '));
});

test('agent text cannot carry a newline into the approval screen', () => {
  const p = clone(valid);
  p.rules[1].then = [{ do: 'notify', text: 'all good\nwhen price above tl_9: open long' }];
  assert.equal(validateProgram(p).ok, false);
});

// Walking the generated JSON schema rather than the source, because the claim is about what
// the schema ACCEPTS. A grep over grammar.ts would pass on a schema that named the field
// `venue` and let an address through it.
type JsonNode = Record<string, unknown>;

const schema = zodToJsonSchema(PROGRAM_SCHEMA, { name: 'Program' }) as JsonNode;

// zod-to-json-schema emits a $ref the second time it meets the same sub-schema, so `text` and
// `reason` share one node and only one of them is written out in full. A walk that stops at a
// $ref checks half the surface and reports the other half as clean, which is the worst kind of
// green. Following the pointer is what makes this test say what it claims to say.
function resolveRef(pointer: string): JsonNode | null {
  if (!pointer.startsWith('#/')) return null;
  let node: unknown = schema;
  for (const part of pointer.slice(2).split('/')) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as JsonNode)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node !== null && typeof node === 'object' ? (node as JsonNode) : null;
}

function walkSchema(visit: (key: string | null, value: JsonNode) => void): void {
  // Condition refers to itself, so the walk needs a stop. Keying on the pair means a shared
  // sub-schema is still checked once under every property name that reaches it.
  const seen = new Set<string>();

  function walk(node: unknown, key: string | null): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    const obj = node as JsonNode;

    if (typeof obj.$ref === 'string') {
      const mark = `${key ?? ''}|${obj.$ref}`;
      if (seen.has(mark)) return;
      seen.add(mark);
      walk(resolveRef(obj.$ref), key);
      return;
    }

    visit(key, obj);

    const properties = obj.properties;
    if (properties !== null && typeof properties === 'object') {
      for (const [name, child] of Object.entries(properties as JsonNode)) walk(child, name);
    }
    // definitions is a bag of named schemas rather than a schema, so its keys are definition
    // names and not property names. They enter the walk with a null key.
    const definitions = obj.definitions;
    if (definitions !== null && typeof definitions === 'object') {
      for (const child of Object.values(definitions as JsonNode)) walk(child, null);
    }
    for (const field of ['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties']) {
      const child = obj[field];
      if (child !== null && typeof child === 'object') walk(child, key);
    }
  }

  walk(schema, null);
}

test('no schema field is named or shaped like an address', () => {
  // The same list tests/injection.test.ts holds the MCP surface to.
  const RECIPIENT_FIELDS = ['to', 'recipient', 'destination', 'address', 'toaddress', 'dest', 'payee', 'wallet'];

  const propertyNames = new Set<string>();
  const longStrings: Array<[string, number]> = [];
  const patterns: string[] = [];
  const constants = new Set<string>();

  walkSchema((key, node) => {
    if (key !== null) propertyNames.add(key.toLowerCase());
    const enumerated = typeof node.const === 'string' || Array.isArray(node.enum);
    if (node.type === 'string' && !enumerated) {
      if (typeof node.pattern === 'string') patterns.push(node.pattern);
      // An unbounded string is the hole this test exists to find: a field that can hold
      // anything, including 42 characters of address.
      const max = typeof node.maxLength === 'number' ? node.maxLength : Infinity;
      if (key !== null && max > 32) longStrings.push([key, max]);
    }
    if (typeof node.const === 'string') constants.add(node.const);
    if (Array.isArray(node.enum)) for (const v of node.enum) if (typeof v === 'string') constants.add(v);
  });

  assert.ok(propertyNames.size > 10, 'the walk found almost nothing, so it is not walking');

  for (const field of RECIPIENT_FIELDS) {
    assert.ok(!propertyNames.has(field), `the grammar exposes a field named ${field}`);
  }
  assert.doesNotMatch(JSON.stringify(schema), /recipient|destination|payee/i);

  // No pattern admits a run of hex long enough to be an address, and none mentions the 0x
  // prefix that would signal somebody was trying.
  for (const pattern of patterns) {
    assert.ok(!pattern.includes('0x'), `a string pattern mentions 0x: ${pattern}`);
    assert.ok(!/\{\s*(4[0-9]|[5-9][0-9])/.test(pattern), `a string pattern allows an address-length run: ${pattern}`);
  }

  // Exactly two strings are longer than an identifier, and both belong to verbs that place no
  // order. Anything new in this list is a new place text can hide, so it has to be argued for
  // here rather than added quietly.
  assert.deepEqual(
    [...new Set(longStrings.map(([name]) => name))].sort(),
    ['reason', 'text'],
    `unexpected long string fields: ${JSON.stringify(longStrings)}`,
  );
  for (const [, max] of longStrings) assert.ok(max <= 200, 'a display string is unbounded');

  // No verb, and no enumerated value anywhere, moves value off the venue.
  for (const value of constants) {
    assert.doesNotMatch(value, /withdraw|transfer|approve|send|bridge|sweep/i, `the grammar enumerates '${value}'`);
  }
});

test('every object in the schema refuses unknown keys', () => {
  let objects = 0;
  walkSchema((_key, node) => {
    if (node.type !== 'object') return;
    objects += 1;
    assert.equal(node.additionalProperties, false, `an object in the schema accepts unknown keys: ${JSON.stringify(node.properties ?? {}).slice(0, 120)}`);
  });
  assert.ok(objects >= 20, `only ${objects} objects walked, so the schema is not being covered`);
});

test('programHash ignores key order and notices any changed value', () => {
  const base = programHash(valid);

  const reordered: Program = {
    invalidate: valid.invalidate,
    rules: valid.rules.map((r) => ({ then: r.then, when: r.when, id: r.id, once: r.once, cooldownSec: r.cooldownSec })),
    symbol: valid.symbol,
  };
  assert.equal(programHash(reordered), base, 'reordering keys changed the hash');

  // An absent optional and an explicitly undefined one are the same program.
  const withUndefined = clone(valid);
  withUndefined.rules[0].cooldownSec = undefined;
  assert.equal(programHash(withUndefined), base);

  const changes: Array<[string, (p: Program) => void]> = [
    ['size', (p) => { const a = p.rules[0].then[0]; if (a.do === 'open') a.sizeUsd = 501; }],
    ['leverage', (p) => { const a = p.rules[0].then[0]; if (a.do === 'open') a.leverage = 4; }],
    ['symbol', (p) => { p.symbol = 'BTC'; }],
    ['ref id', (p) => { const a = p.rules[0].then[1]; if (a.do === 'set_stop') a.ref = { kind: 'drawing', id: 'zn_2' }; }],
    ['rule id', (p) => { p.rules[0].id = 'entry2'; }],
    ['once', (p) => { p.rules[0].once = false; }],
    ['invalidate', (p) => { p.invalidate = undefined; }],
    ['rule order', (p) => { p.rules.reverse(); }],
  ];
  for (const [what, mutate] of changes) {
    const p = clone(valid);
    mutate(p);
    assert.notEqual(programHash(p), base, `changing the ${what} left the hash alone`);
  }
});

test('programHash is a plain sha256 hex digest', () => {
  assert.match(programHash(valid), /^[0-9a-f]{64}$/);
});

test('actionVerbs is sorted and deduped', () => {
  const p: Program = {
    symbol: 'BTC',
    rules: [
      {
        id: 'a',
        when: { op: 'position', state: 'flat' },
        then: [
          { do: 'notify', text: 'go' },
          { do: 'open', side: 'short', sizeUsd: 100, leverage: 2, entry: { type: 'market', maxSlippageBps: 10 } },
          { do: 'set_stop', ref: { kind: 'price', value: 70_000 } },
        ],
      },
      {
        id: 'b',
        when: { op: 'position', state: 'short' },
        then: [
          { do: 'notify', text: 'again' },
          { do: 'cancel', which: 'all' },
        ],
      },
    ],
  };
  assert.deepEqual(actionVerbs(p), ['cancel', 'notify', 'open', 'set_stop']);
  assert.deepEqual(actionVerbs(p), [...actionVerbs(p)].sort());
});

test('validateProgram reports where the problem is without echoing the input back', () => {
  const r = validateProgram({ symbol: 'ETH', rules: [{ id: 'a', when: { op: 'nope' }, then: [] }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.length > 0);
  for (const e of r.errors) assert.ok(e.length <= 200, `an error message ran to ${e.length} characters`);
});

test('a program with no rules is refused', () => {
  assert.equal(validateProgram({ symbol: 'ETH', rules: [] }).ok, false);
});
