import { describe, expect, it } from 'vitest';
import { generateActivityStatus, getToolActivity } from './tool-activity-map';

describe('tool activity labels', () => {
  it('labels file reads as reading files rather than context gathering', () => {
    expect(getToolActivity('Read')).toBe('Reading files');
    expect(getToolActivity('read')).toBe('Reading files');
    expect(generateActivityStatus('Read')).toBe('Reading files');
  });
});
