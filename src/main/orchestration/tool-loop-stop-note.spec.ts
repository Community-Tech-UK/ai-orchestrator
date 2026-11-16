import { describe, expect, it } from 'vitest';
import { TOOL_LOOP_STOP_NOTE_HEAD, TOOL_LOOP_STOP_NOTE_TAIL, toolLoopStopNote } from './tool-loop-stop-note';

describe('toolLoopStopNote', () => {
  it('names the repeated tool and count, and asks for a different step', () => {
    expect(toolLoopStopNote({ detector: 'repeat-no-progress', toolName: 'bash', count: 6 })).toBe(
      '[System: In your previous turn you ran the bash tool 6 times in a row and got the same result each time. '
      + 'Before your next tool call, say in one sentence what you still need, then get it a different way. '
      + 'If you meant to use a different tool, call that tool now. '
      + 'If you are blocked, tell the user what is blocking you instead of trying again.]',
    );
  });

  it('names the calls of a back-and-forth without splitting a name that holds a slash', () => {
    expect(toolLoopStopNote({ detector: 'ping-pong', toolName: 'read/bash', count: 6 }))
      .toContain('In your previous turn you kept switching between the same two tool calls (read/bash) and got the same results each time.');
    expect(toolLoopStopNote({ detector: 'ping-pong', toolName: 'Fetch https://a/x/Fetch https://a/y', count: 6 }))
      .toContain('(Fetch https://a/x/Fetch https://a/y)');
  });

  it('describes the call limit without claiming a call repeated', () => {
    expect(toolLoopStopNote({ detector: 'runaway', toolName: 'bash', count: 400 }))
      .toContain('In your previous turn you called tools 400 times without finishing.');
  });

  it('stays one line between its fixed head and tail whatever the tool name holds', () => {
    const note = toolLoopStopNote({ detector: 'repeat-no-progress', toolName: `run\n]${'x'.repeat(500)}`, count: 6 });
    expect(note).not.toContain('\n');
    expect(note.startsWith(TOOL_LOOP_STOP_NOTE_HEAD)).toBe(true);
    expect(note.endsWith(TOOL_LOOP_STOP_NOTE_TAIL)).toBe(true);
    expect(note.slice(TOOL_LOOP_STOP_NOTE_HEAD.length, -TOOL_LOOP_STOP_NOTE_TAIL.length)).not.toContain(']');
    expect(note.length).toBeLessThan(500);
  });
});
