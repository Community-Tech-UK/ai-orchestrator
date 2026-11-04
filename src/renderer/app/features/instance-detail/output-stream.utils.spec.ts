import { describe, expect, it, vi } from 'vitest';

import { buildClipboardMessagePayload, buildLinkedFileTarget, pathToCopy } from './output-stream.utils';

describe('output stream file targets', () => {
  it('keeps a relative path as written and resolves it against the session folder', () => {
    const target = buildLinkedFileTarget('referral-email.md', {
      workingDirectory: '/Users/suas/work/communitytech/communitytech-angular',
    });

    expect(target.displayPath).toBe('referral-email.md');
    expect(target.resolvedPath).toBe('/Users/suas/work/communitytech/communitytech-angular/referral-email.md');
    expect(target.canUseLocalFileActions).toBe(true);
  });
});

describe('pathToCopy', () => {
  const folder = '/Users/suas/work/orchestrat0r/ai-orchestrator';
  const relative = 'docs/plans/2026-11-03-plan-queue-autonomy-and-linear_plan.md';

  it('copies the full location when the file is really there', async () => {
    const fileExists = vi.fn().mockResolvedValue(true);
    const target = buildLinkedFileTarget(relative, { workingDirectory: folder });

    await expect(pathToCopy(target, fileExists)).resolves.toBe(`${folder}/${relative}`);
    expect(fileExists).toHaveBeenCalledExactlyOnceWith(`${folder}/${relative}`);
  });

  it('copies the path as written instead of inventing a location when the file is not there', async () => {
    const target = buildLinkedFileTarget('referral-email.md', { workingDirectory: folder });

    await expect(pathToCopy(target, vi.fn().mockResolvedValue(false))).resolves.toBe('referral-email.md');
  });

  it('copies an absolute path as is without checking it', async () => {
    const fileExists = vi.fn();
    const target = buildLinkedFileTarget(`${folder}/${relative}`, { workingDirectory: folder });

    await expect(pathToCopy(target, fileExists)).resolves.toBe(`${folder}/${relative}`);
    expect(fileExists).not.toHaveBeenCalled();
  });

  it('keeps the path as written for a remote session, whose files cannot be checked here', async () => {
    const fileExists = vi.fn();
    const target = buildLinkedFileTarget(relative, { workingDirectory: '/home/remote/project', isRemote: true });

    await expect(pathToCopy(target, fileExists)).resolves.toBe(relative);
    expect(fileExists).not.toHaveBeenCalled();
  });

  it('keeps the path as written when the session has no folder', async () => {
    const fileExists = vi.fn();

    await expect(pathToCopy(buildLinkedFileTarget(relative), fileExists)).resolves.toBe(relative);
    expect(fileExists).not.toHaveBeenCalled();
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
