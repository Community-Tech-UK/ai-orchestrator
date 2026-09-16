import { describe, expect, it } from 'vitest';
import {
  toFileAttachments,
  toInstanceProvider,
} from './instance-handlers-utils';

describe('instance IPC payload normalizers', () => {
  it('fills omitted attachment data from the Zod payload', () => {
    expect(toFileAttachments(undefined)).toBeUndefined();
    expect(toFileAttachments([
      { name: 'note.md', type: 'text/markdown', size: 4 },
    ])).toEqual([
      { name: 'note.md', type: 'text/markdown', size: 4, data: '' },
    ]);
  });

  it('treats auto as an unresolved provider', () => {
    expect(toInstanceProvider(undefined)).toBeUndefined();
    expect(toInstanceProvider('auto')).toBeUndefined();
    expect(toInstanceProvider('claude')).toBe('claude');
  });
});
