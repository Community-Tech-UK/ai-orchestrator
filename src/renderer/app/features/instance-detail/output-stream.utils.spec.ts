import { describe, expect, it } from 'vitest';

import { buildClipboardMessagePayload, buildLinkedFileTarget } from './output-stream.utils';

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

describe('buildClipboardMessagePayload', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  it('keeps images out of the plain-text attachment list', () => {
    const payload = buildClipboardMessagePayload('Oh wow, this is ugly', [
      { name: 'image.png', type: 'image/png', size: 120, data: png },
    ]);

    expect(payload).toEqual({
      text: 'Oh wow, this is ugly',
      images: [{ dataUrl: png, name: 'image.png' }],
      attachments: [],
    });
  });

  it('lists non-image attachments and skips ones without data URLs', () => {
    const payload = buildClipboardMessagePayload('See file', [
      { name: 'plan.md', type: 'text/markdown', size: 10, data: 'data:text/markdown;base64,IyBQ' },
      { name: 'missing.png', type: 'image/png', size: 10, data: '/tmp/missing.png' },
    ]);

    expect(payload?.images).toEqual([]);
    expect(payload?.attachments).toEqual([
      { name: 'plan.md', type: 'text/markdown', size: 10, dataUrl: 'data:text/markdown;base64,IyBQ' },
    ]);
  });

  it('copies an image-only message and returns null when there is nothing to copy', () => {
    expect(
      buildClipboardMessagePayload('', [{ name: 'a.png', type: 'image/png', size: 1, data: png }])?.images,
    ).toHaveLength(1);
    expect(buildClipboardMessagePayload('', [])).toBeNull();
  });
});
