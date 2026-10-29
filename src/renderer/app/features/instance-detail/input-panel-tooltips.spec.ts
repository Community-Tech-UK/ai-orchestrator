import { describe, expect, it } from 'vitest';
import { voiceTooltipParts } from './input-panel-tooltips';

describe('voiceTooltipParts', () => {
  it.each([
    [true, false, false, false, 'Start voice conversation', 'Start a session before using voice'],
    [false, true, false, false, 'Start voice conversation', 'Voice is available after the session starts'],
    [false, false, true, false, 'Start voice conversation', 'Voice is unavailable right now'],
    [false, false, false, true, 'Stop voice conversation', null],
    [false, false, false, false, 'Start voice conversation', null],
    [false, false, true, true, 'Stop voice conversation', null],
  ] as const)('preserves the name and reason for draft=%s starting=%s disabled=%s active=%s', (draft, starting, disabled, active, name, disabledReason) => {
    expect(voiceTooltipParts({ isDraftComposer: () => draft, isInitializing: () => starting, disabled: () => disabled, isVoiceActive: () => active })).toEqual({ name, disabledReason });
  });
});
