import { describe, expect, it } from 'vitest';
import { turnStartKind } from './turn-start';

describe('turnStartKind', () => {
  it('treats a user message as the start of a turn, whoever delivered it', () => {
    expect(turnStartKind({ type: 'user' })).toBe('user');
    expect(turnStartKind({ type: 'user', metadata: { kind: 'loop-start' } })).toBe('user');
    expect(turnStartKind({
      type: 'user',
      metadata: { crossSessionMessage: { sourceInstanceId: 'a', sourceDisplayName: 'A', hopCount: 1 } },
    })).toBe('user');
  });

  it('treats input Harness wrote itself as the start of a machine turn', () => {
    expect(turnStartKind({
      type: 'system',
      metadata: { internalInput: { actor: 'harness', source: 'async-work-continuation' } },
    })).toBe('machine');
  });

  it('does not treat ordinary output or notices as turn starts', () => {
    expect(turnStartKind({ type: 'assistant' })).toBeNull();
    expect(turnStartKind({ type: 'system' })).toBeNull();
    expect(turnStartKind({ type: 'system', metadata: { kind: 'interrupt-boundary' } })).toBeNull();
    expect(turnStartKind({ type: 'tool_use' })).toBeNull();
    expect(turnStartKind({ type: 'tool_result' })).toBeNull();
    expect(turnStartKind({ type: 'error' })).toBeNull();
    expect(turnStartKind({ type: 'tool_outcome' })).toBeNull();
  });

  it('ignores an internalInput stamp on a message type that is not system', () => {
    expect(turnStartKind({ type: 'assistant', metadata: { internalInput: { actor: 'harness', source: 'plan-queue' } } }))
      .toBeNull();
  });
});
