import { describe, expect, it } from 'vitest';
import { readCapturedToolArguments } from './tool-call-argument-material';

describe('readCapturedToolArguments', () => {
  it('treats an ACP kind-only argument object as uncaptured', () => {
    // Cursor grep / Read File: `rawInput: {}` on the wire, `{ kind }` after the adapter.
    expect(readCapturedToolArguments({ kind: 'search' })).toBeUndefined();
    expect(readCapturedToolArguments({ kind: 'read', rawInput: {} })).toBeUndefined();
  });

  it('keeps ACP arguments that carry real input', () => {
    const execute = { kind: 'execute', rawInput: { command: 'wc -l notes.txt' } };
    expect(readCapturedToolArguments(execute)).toBe(execute);
    const withLocation = { kind: 'read', path: 'notes.txt' };
    expect(readCapturedToolArguments(withLocation)).toBe(withLocation);
  });

  it('leaves non-ACP shapes alone, including a genuinely empty object', () => {
    const empty = {};
    expect(readCapturedToolArguments(empty)).toBe(empty);
    const claude = { file_path: '/repo/src/index.ts' };
    expect(readCapturedToolArguments(claude)).toBe(claude);
    // A non-string `kind` is ordinary data, not the ACP discriminator.
    const numericKind = { kind: 3 };
    expect(readCapturedToolArguments(numericKind)).toBe(numericKind);
  });

  it('returns undefined for anything that is not a record', () => {
    expect(readCapturedToolArguments(undefined)).toBeUndefined();
    expect(readCapturedToolArguments(null)).toBeUndefined();
    expect(readCapturedToolArguments('grep')).toBeUndefined();
    expect(readCapturedToolArguments(['grep'])).toBeUndefined();
  });
});
