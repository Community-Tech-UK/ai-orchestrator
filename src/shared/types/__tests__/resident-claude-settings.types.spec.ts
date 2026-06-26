import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.types';

describe('DEFAULT_SETTINGS — resident Claude steering', () => {
  it('enables resident Claude sessions by default', () => {
    expect(DEFAULT_SETTINGS.residentClaudeSession).toBe(true);
  });
});
