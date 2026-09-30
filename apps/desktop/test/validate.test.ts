import { describe, expect, it } from 'vitest';
import { CommandValidationError, validateCommandRequest } from '../src/main/validate.ts';
import {
  CHILD_SORT_KEYS,
  COMMANDS,
  MAX_CHILDREN_PAGE_SIZE,
  MAX_PATH_LENGTH,
  SORT_ORDERS,
} from '../src/shared/protocol.ts';

/**
 * The renderer is the least trusted part of this application, and this validator is the only
 * thing between it and the filesystem. It is hand-written rather than schema-driven, so these
 * tests carry the weight a library's reputation would otherwise carry.
 */

function expectRejected(raw: unknown, pattern?: RegExp): CommandValidationError {
  let thrown: unknown;
  try {
    validateCommandRequest(raw);
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected ${JSON.stringify(raw)} to be rejected`).toBeInstanceOf(
    CommandValidationError,
  );
  const error = thrown as CommandValidationError;
  if (pattern !== undefined) expect(error.message).toMatch(pattern);
  return error;
}

describe('envelope validation', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'startScan'],
    ['an array', ['startScan']],
    ['a boolean', true],
  ])('rejects %s as a request', (_label, raw) => {
    expectRejected(raw);
  });

  it('rejects an unknown command with a distinguishable code', () => {
    const error = expectRejected({ command: 'deleteEverything', payload: {} });
    expect(error.code).toBe('unknownCommand');
  });

  it('rejects a command name that is not a string', () => {
    expect(expectRejected({ command: 7, payload: {} }).code).toBe('unknownCommand');
  });

  it('rejects an object with an absurd number of properties', () => {
    const raw: Record<string, unknown> = { command: 'queryStatus', payload: {} };
    for (let index = 0; index < 64; index += 1) raw[`filler-${index}`] = index;
    expectRejected(raw, /too many properties/);
  });

  it('rejects an own __proto__ property', () => {
    // Structured clone does not carry prototypes, so this cannot arrive as a real prototype
    // chain, but an own key of that name can. Refusing it makes the intent explicit.
    const raw = JSON.parse('{"command":"queryStatus","payload":{"__proto__":{"x":1}}}') as unknown;
    expectRejected(raw, /__proto__/);
  });

  it('treats a missing payload as an empty one', () => {
    expect(validateCommandRequest({ command: 'queryStatus' })).toEqual({
      command: 'queryStatus',
      payload: {},
    });
  });

  it('every declared command is handled', () => {
    // Guards against a command being added to the protocol without a validator, which would
    // otherwise fall through to a runtime surprise rather than a compile error.
    for (const command of COMMANDS) {
      const payloadFor: Record<string, unknown> = {
        listVolumes: {},
        pickDirectory: {},
        queryStatus: {},
        startScan: { path: '/tmp' },
        cancelScan: { scanId: 'abc-123def' },
        queryNode: { nodeId: 0 },
        queryChildren: { nodeId: 0, sort: 'size', order: 'desc', offset: 0, limit: 10 },
      };
      const request = validateCommandRequest({ command, payload: payloadFor[command] });
      expect(request.command).toBe(command);
    }
  });
});

describe('argument-free commands', () => {
  it.each(['listVolumes', 'pickDirectory', 'queryStatus'])(
    '%s accepts an empty payload',
    (command) => {
      expect(validateCommandRequest({ command, payload: {} })).toEqual({ command, payload: {} });
    },
  );

  it('rejects stray arguments rather than ignoring them', () => {
    // Silently dropping an unexpected field is how a validated boundary stops being one.
    expectRejected({ command: 'queryStatus', payload: { nodeId: 3 } }, /takes no arguments/);
  });
});

describe('startScan', () => {
  it('accepts a plain path', () => {
    expect(
      validateCommandRequest({ command: 'startScan', payload: { path: 'C:\\Users' } }),
    ).toEqual({ command: 'startScan', payload: { path: 'C:\\Users' } });
  });

  it('rejects a path containing a NUL byte', () => {
    // The important one: several platform APIs treat a path as NUL-terminated, so an embedded
    // NUL can make the path that was validated differ from the path that gets opened.
    expectRejected(
      { command: 'startScan', payload: { path: '/safe\u0000/../../etc/passwd' } },
      /NUL/,
    );
  });

  it.each([
    ['a missing path', {}],
    ['an empty path', { path: '' }],
    ['a blank path', { path: '   ' }],
    ['a non-string path', { path: 42 }],
    ['a null path', { path: null }],
    ['an array path', { path: ['/tmp'] }],
  ])('rejects %s', (_label, payload) => {
    expectRejected({ command: 'startScan', payload });
  });

  it('rejects a path beyond the length limit', () => {
    const path = `/${'a'.repeat(MAX_PATH_LENGTH)}`;
    expectRejected({ command: 'startScan', payload: { path } }, /at most/);
  });

  it('accepts a path exactly at the limit', () => {
    const path = 'a'.repeat(MAX_PATH_LENGTH);
    expect(validateCommandRequest({ command: 'startScan', payload: { path } }).command).toBe(
      'startScan',
    );
  });

  it('does not attempt to interpret the path itself', () => {
    // Path semantics are the provider's job. Traversal sequences are not rejected here because
    // the resolved path is what matters, and the renderer cannot name a path it did not get
    // from the user's own directory picker.
    const payload = { path: '/home/../home/./user' };
    expect(validateCommandRequest({ command: 'startScan', payload })).toEqual({
      command: 'startScan',
      payload,
    });
  });
});

describe('cancelScan', () => {
  it('accepts a well-formed scan id', () => {
    expect(
      validateCommandRequest({ command: 'cancelScan', payload: { scanId: 'm9k2x1-4fa0bc12de34' } }),
    ).toEqual({ command: 'cancelScan', payload: { scanId: 'm9k2x1-4fa0bc12de34' } });
  });

  it.each([
    ['an empty id', ''],
    ['an id with no separator', 'abcdef'],
    ['an id with uppercase', 'ABC-123'],
    ['an id with a path', '../../etc/passwd'],
    ['an id with spaces', 'abc 123'],
    ['an overlong id', `${'a'.repeat(80)}-${'b'.repeat(80)}`],
  ])('rejects %s', (_label, scanId) => {
    expectRejected({ command: 'cancelScan', payload: { scanId } });
  });
});

describe('queryNode', () => {
  it('accepts a node id of zero', () => {
    expect(validateCommandRequest({ command: 'queryNode', payload: { nodeId: 0 } })).toEqual({
      command: 'queryNode',
      payload: { nodeId: 0 },
    });
  });

  it.each([
    ['a negative id', -1],
    ['a fractional id', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '3'],
    ['a bigint-ish value', 2_147_483_648],
  ])('rejects %s', (_label, nodeId) => {
    expectRejected({ command: 'queryNode', payload: { nodeId } });
  });
});

describe('queryChildren', () => {
  const valid = { nodeId: 4, sort: 'size', order: 'desc', offset: 0, limit: 100 };

  it('accepts a well-formed page request', () => {
    expect(validateCommandRequest({ command: 'queryChildren', payload: valid })).toEqual({
      command: 'queryChildren',
      payload: valid,
    });
  });

  it('accepts every declared sort key and order', () => {
    for (const sort of CHILD_SORT_KEYS) {
      for (const order of SORT_ORDERS) {
        const request = validateCommandRequest({
          command: 'queryChildren',
          payload: { ...valid, sort, order },
        });
        expect(request.command).toBe('queryChildren');
      }
    }
  });

  it('rejects an unknown sort key or order', () => {
    expectRejected({ command: 'queryChildren', payload: { ...valid, sort: 'entropy' } });
    expectRejected({ command: 'queryChildren', payload: { ...valid, order: 'sideways' } });
  });

  it('refuses an oversized page rather than quietly clamping it', () => {
    // Clamping would mean the renderer's request and the response disagree about how much data
    // was asked for, which makes pagination bugs very hard to see.
    expectRejected(
      { command: 'queryChildren', payload: { ...valid, limit: MAX_CHILDREN_PAGE_SIZE + 1 } },
      /between 1 and/,
    );
  });

  it('accepts the maximum page size', () => {
    expect(
      validateCommandRequest({
        command: 'queryChildren',
        payload: { ...valid, limit: MAX_CHILDREN_PAGE_SIZE },
      }).payload,
    ).toEqual({ ...valid, limit: MAX_CHILDREN_PAGE_SIZE });
  });

  it('rejects a zero or negative page size', () => {
    expectRejected({ command: 'queryChildren', payload: { ...valid, limit: 0 } });
    expectRejected({ command: 'queryChildren', payload: { ...valid, limit: -5 } });
  });

  it('rejects missing fields', () => {
    for (const key of Object.keys(valid)) {
      const partial: Record<string, unknown> = { ...valid };
      delete partial[key];
      expectRejected({ command: 'queryChildren', payload: partial });
    }
  });

  it('returns a payload built from scratch, not the caller object', () => {
    // A handler must never receive the renderer's object: an extra property riding along is how
    // an unchecked value reaches code that assumes everything was validated.
    const hostile = { ...valid, extra: 'ignored', toString: 'not a function' };
    const request = validateCommandRequest({ command: 'queryChildren', payload: hostile });
    expect(request.payload).not.toBe(hostile);
    expect(Object.keys(request.payload).sort()).toEqual([
      'limit',
      'nodeId',
      'offset',
      'order',
      'sort',
    ]);
  });
});
