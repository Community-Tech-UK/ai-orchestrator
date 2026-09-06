import { describe, expect, it } from 'vitest';
import { isProgressNoteMessage } from './progress-note';
import type { OutputMessage } from '../../core/state/instance/instance.types';

function assistant(metadata?: Record<string, unknown>): OutputMessage {
  return { id: 'm1', type: 'assistant', content: 'Checking the Apple tab.', timestamp: 1, metadata } as OutputMessage;
}

describe('isProgressNoteMessage', () => {
  it('recognises an assistant message written to the commentary channel', () => {
    expect(isProgressNoteMessage(assistant({ messagePhase: 'commentary' }))).toBe(true);
  });

  it('treats a final answer as an ordinary reply', () => {
    expect(isProgressNoteMessage(assistant({ messagePhase: 'final_answer' }))).toBe(false);
  });

  it('treats an untagged message as an ordinary reply', () => {
    // Providers other than Codex, and Codex builds predating the phase field,
    // send no messagePhase at all. Those must keep rendering as they always did.
    expect(isProgressNoteMessage(assistant())).toBe(false);
    expect(isProgressNoteMessage(assistant({ streaming: true }))).toBe(false);
  });

  it('never demotes a non-assistant message', () => {
    const userNote = { ...assistant({ messagePhase: 'commentary' }), type: 'user' } as OutputMessage;
    expect(isProgressNoteMessage(userNote)).toBe(false);
  });

  it('tolerates a missing message', () => {
    expect(isProgressNoteMessage(undefined)).toBe(false);
  });
});
