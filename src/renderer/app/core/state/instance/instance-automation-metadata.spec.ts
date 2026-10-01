import { describe, expect, it } from 'vitest';
import { withAutomationRevealed } from './instance-automation-metadata';

describe('withAutomationRevealed', () => {
  it('folds the stamp into existing metadata', () => {
    expect(withAutomationRevealed({ automationHidden: true }, true)).toEqual({
      automationHidden: true,
      automationRevealed: true,
    });
  });

  it('creates metadata when the instance had none', () => {
    expect(withAutomationRevealed(undefined, true)).toEqual({ automationRevealed: true });
  });

  it('preserves the stamp on updates that do not carry it', () => {
    const metadata = { automationHidden: true, automationRevealed: true };
    expect(withAutomationRevealed(metadata, undefined)).toBe(metadata);
  });

  it('returns metadata untouched when there is no stamp', () => {
    const metadata = { automationHidden: true };
    expect(withAutomationRevealed(metadata, undefined)).toBe(metadata);
    expect(withAutomationRevealed(undefined, undefined)).toBeUndefined();
  });
});
