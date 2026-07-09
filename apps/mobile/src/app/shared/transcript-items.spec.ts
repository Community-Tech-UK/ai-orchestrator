import { describe, expect, it } from 'vitest';
import type { MobileMessageDto } from '../core/models';
import { buildDisplayItems, isLoopTranscriptMessage, toolLabel } from './transcript-items';

function msg(overrides: Partial<MobileMessageDto>): MobileMessageDto {
  return {
    id: 'm1',
    timestamp: 0,
    type: 'assistant',
    content: '',
    ...overrides,
  };
}

describe('toolLabel', () => {
  it('prefers the tool name from metadata', () => {
    expect(toolLabel(msg({ metadata: { toolName: 'Bash' }, content: 'raw' }))).toBe('Bash');
    expect(toolLabel(msg({ metadata: { tool_name: 'Read' }, content: 'raw' }))).toBe('Read');
  });

  it('falls back to content, then a generic label', () => {
    expect(toolLabel(msg({ content: 'ls -la' }))).toBe('ls -la');
    expect(toolLabel(msg({}))).toBe('tool');
  });
});

describe('isLoopTranscriptMessage', () => {
  it('identifies loop transcript system and assistant messages from metadata', () => {
    expect(isLoopTranscriptMessage(msg({ metadata: { kind: 'loop-iteration' } }))).toBe(true);
    expect(isLoopTranscriptMessage(msg({ metadata: { kind: 'loop-summary' } }))).toBe(true);
    expect(isLoopTranscriptMessage(msg({ metadata: { kind: 'loop-start' } }))).toBe(true);
    expect(isLoopTranscriptMessage(msg({ metadata: { kind: 'loop-intervene' } }))).toBe(true);
  });

  it('does not classify ordinary transcript messages as loop output', () => {
    expect(isLoopTranscriptMessage(msg({ metadata: { kind: 'permission' } }))).toBe(false);
    expect(isLoopTranscriptMessage(msg({ metadata: {} }))).toBe(false);
    expect(isLoopTranscriptMessage(msg({}))).toBe(false);
  });
});

describe('buildDisplayItems', () => {
  it('groups consecutive tool messages and keeps prose separate', () => {
    const now = Date.parse('2026-07-07T12:00:00Z');
    const items = buildDisplayItems(
      [
        msg({ id: 'a', type: 'user', content: 'do it', timestamp: now }),
        msg({ id: 'b', type: 'tool_use', content: 'Bash', timestamp: now }),
        msg({ id: 'c', type: 'tool_result', content: 'ok', timestamp: now }),
        msg({ id: 'd', type: 'assistant', content: 'done', timestamp: now }),
      ],
      now,
    );

    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(['stamp', 'msg', 'tools', 'msg']);
    const tools = items.find((i) => i.kind === 'tools');
    expect(tools?.kind === 'tools' && tools.items).toHaveLength(2);
  });
});
