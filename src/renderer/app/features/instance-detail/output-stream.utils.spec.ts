import { describe, expect, it } from 'vitest';

import { buildLinkedFileTarget } from './output-stream.utils';

describe('output stream file targets', () => {
  it('copies the literal relative path instead of inventing an absolute workspace path', () => {
    const target = buildLinkedFileTarget('referral-email.md', {
      workingDirectory: '/Users/suas/work/communitytech/communitytech-angular',
    });

    expect(target.displayPath).toBe('referral-email.md');
    expect(target.resolvedPath).toBe('/Users/suas/work/communitytech/communitytech-angular/referral-email.md');
    expect(target.canUseLocalFileActions).toBe(true);
  });
});
