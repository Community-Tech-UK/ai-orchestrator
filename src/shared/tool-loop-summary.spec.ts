import { describe, expect, it } from 'vitest';
import { TOOL_LOOP_TITLE, describeToolLoop } from './tool-loop-summary';

describe('describeToolLoop', () => {
  it('says a repeated call got the same result each time', () => {
    expect(describeToolLoop({ detector: 'repeat-no-progress', toolName: 'Bash', count: 12 }))
      .toBe('It has run Bash 12 times in a row and got the same result each time.');
  });

  it('names both tools when the session keeps switching between two', () => {
    expect(describeToolLoop({ detector: 'ping-pong', toolName: 'Read/Bash', count: 16 }))
      .toBe('It keeps switching between Read and Bash and getting the same results each time.');
  });

  it('says "two calls" when one tool is called two different ways', () => {
    expect(describeToolLoop({ detector: 'ping-pong', toolName: 'Read', count: 16 }))
      .toBe('It keeps switching between two Read calls and getting the same results each time.');
  });

  it('counts every tool use in the turn for a runaway turn', () => {
    expect(describeToolLoop({ detector: 'runaway', toolName: 'Edit', count: 400 }))
      .toBe('It has used tools 400 times in this turn without finishing.');
  });

  it('shows tool-server tool names the way the rest of the app does', () => {
    expect(describeToolLoop({ detector: 'repeat-no-progress', toolName: 'mcp__browser-gateway__browser_snapshot', count: 6 }))
      .toBe('It has run browser_snapshot (browser-gateway) 6 times in a row and got the same result each time.');
  });

  it('keeps the shared title free of the word "loop", which names a separate feature', () => {
    expect(TOOL_LOOP_TITLE).not.toMatch(/loop/i);
    for (const detector of ['repeat-no-progress', 'ping-pong', 'runaway'] as const) {
      expect(describeToolLoop({ detector, toolName: 'Bash', count: 8 })).not.toMatch(/loop/i);
    }
  });
});
