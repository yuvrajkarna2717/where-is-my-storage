import {
  CHILD_SORT_KEYS,
  COMMANDS,
  MAX_CHILDREN_PAGE_SIZE,
  MAX_PATH_LENGTH,
  SORT_ORDERS,
  type CommandErrorCode,
  type CommandName,
  type CommandRequest,
} from '../shared/protocol.ts';

/**
 * Validation for everything arriving from the renderer.
 *
 * Hand-written rather than schema-library driven. That is a deliberate choice against the
 * original plan, for three reasons: the surface is seven commands of primitive fields, the
 * limits that matter here are not expressible as a schema (a maximum page size, a NUL-byte
 * rejection, a bound on how many keys an object may carry), and this is the one security
 * boundary in the application, so it is worth being able to read the whole thing in one
 * sitting. The tradeoff is that correctness rests on tests rather than on a library's
 * reputation, so the tests are thorough. If the protocol ever grows nested or recursive
 * payloads, revisit.
 *
 * Two habits run through it:
 *
 * - **Never pass the caller's object on.** Every validator constructs a fresh payload from
 *   values it has checked, so no unexpected property can ride along into a handler.
 * - **Reject rather than coerce.** `"5"` is not 5 and `null` is not absent. Silent coercion
 *   is how a validated boundary stops being one.
 */

const MAX_OBJECT_KEYS = 16;
const MAX_SCAN_ID_LENGTH = 64;
const SCAN_ID_PATTERN = /^[0-9a-z]+-[0-9a-z]+$/;
const MAX_SAFE_INDEX = 2_147_483_647;

export class CommandValidationError extends Error {
  readonly code: CommandErrorCode;

  constructor(code: CommandErrorCode, message: string) {
    super(message);
    this.name = 'CommandValidationError';
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new CommandValidationError('invalidRequest', message);
}

/**
 * Narrows to a plain object.
 *
 * Structured clone does not transfer prototypes, so a prototype-pollution payload cannot
 * arrive that way, but an own `__proto__` string key can. It is rejected explicitly so the
 * intent is visible rather than depending on a reader knowing the clone semantics.
 */
function plainRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${where} must be an object`);
  }

  const keys = Object.keys(value);
  if (keys.length > MAX_OBJECT_KEYS) {
    invalid(`${where} has too many properties (${keys.length})`);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    if (Object.hasOwn(value, key)) invalid(`${where} must not carry a ${key} property`);
  }

  return value as Record<string, unknown>;
}

function requireEmpty(record: Record<string, unknown>, where: string): void {
  const keys = Object.keys(record);
  if (keys.length > 0) invalid(`${where} takes no arguments but received ${keys.join(', ')}`);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  where: string,
  maxLength: number,
): string {
  const value = record[key];
  if (typeof value !== 'string') invalid(`${where}.${key} must be a string`);
  if (value.length === 0) invalid(`${where}.${key} must not be empty`);
  if (value.length > maxLength) {
    invalid(`${where}.${key} must be at most ${maxLength} characters`);
  }
  return value;
}

function requireInteger(
  record: Record<string, unknown>,
  key: string,
  where: string,
  min: number,
  max: number,
): number {
  const value = record[key];
  // Number.isInteger rejects NaN, Infinity and non-numbers, and no coercion is attempted:
  // a numeric string is a malformed request, not a number.
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    invalid(`${where}.${key} must be an integer`);
  }
  if (value < min || value > max) {
    invalid(`${where}.${key} must be between ${min} and ${max}`);
  }
  return value;
}

function requireLiteral<T extends string>(
  record: Record<string, unknown>,
  key: string,
  where: string,
  allowed: readonly T[],
): T {
  const value = record[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    invalid(`${where}.${key} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * A filesystem path from the renderer.
 *
 * The NUL rejection is the one that matters: many platform APIs treat a path as a
 * NUL-terminated string, so an embedded NUL can make the path that gets checked differ from
 * the path that gets opened.
 */
function requirePath(record: Record<string, unknown>, where: string): string {
  const path = requireString(record, 'path', where, MAX_PATH_LENGTH);
  if (path.includes('\0')) invalid(`${where}.path must not contain a NUL character`);
  if (path.trim().length === 0) invalid(`${where}.path must not be blank`);
  return path;
}

function isCommandName(value: unknown): value is CommandName {
  return typeof value === 'string' && (COMMANDS as readonly string[]).includes(value);
}

/**
 * Validates a request envelope and returns a freshly built, fully checked equivalent.
 * Throws `CommandValidationError` for anything else.
 */
export function validateCommandRequest(raw: unknown): CommandRequest {
  const envelope = plainRecord(raw, 'request');

  const command = envelope['command'];
  if (!isCommandName(command)) {
    throw new CommandValidationError(
      'unknownCommand',
      `unknown command ${typeof command === 'string' ? command : typeof command}`,
    );
  }

  const payload = plainRecord(envelope['payload'] ?? {}, `${command} payload`);
  const where = command;

  switch (command) {
    // Spelled out per command rather than grouped, so each `return` narrows to exactly one
    // member of the discriminated union with no cast.
    case 'listVolumes':
      requireEmpty(payload, where);
      return { command: 'listVolumes', payload: {} };

    case 'pickDirectory':
      requireEmpty(payload, where);
      return { command: 'pickDirectory', payload: {} };

    case 'queryStatus':
      requireEmpty(payload, where);
      return { command: 'queryStatus', payload: {} };

    case 'startScan':
      return { command: 'startScan', payload: { path: requirePath(payload, where) } };

    case 'cancelScan': {
      const scanId = requireString(payload, 'scanId', where, MAX_SCAN_ID_LENGTH);
      // Scan ids are generated by the scan host in a known shape; anything else is either a
      // stale id from a previous session or something the renderer invented.
      if (!SCAN_ID_PATTERN.test(scanId)) invalid(`${where}.scanId is not a valid scan id`);
      return { command: 'cancelScan', payload: { scanId } };
    }

    case 'queryNode':
      return {
        command: 'queryNode',
        payload: { nodeId: requireInteger(payload, 'nodeId', where, 0, MAX_SAFE_INDEX) },
      };

    case 'queryChildren':
      return {
        command: 'queryChildren',
        payload: {
          nodeId: requireInteger(payload, 'nodeId', where, 0, MAX_SAFE_INDEX),
          sort: requireLiteral(payload, 'sort', where, CHILD_SORT_KEYS),
          order: requireLiteral(payload, 'order', where, SORT_ORDERS),
          offset: requireInteger(payload, 'offset', where, 0, MAX_SAFE_INDEX),
          // The cap is enforced here rather than clamped later, so a renderer asking for a
          // million rows gets told no instead of quietly getting five hundred.
          limit: requireInteger(payload, 'limit', where, 1, MAX_CHILDREN_PAGE_SIZE),
        },
      };
  }
}
