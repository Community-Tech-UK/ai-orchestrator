import { describe, expect, it } from 'vitest';

import { toAcpPromptBlockFromAttachment } from './acp-attachment-blocks';

describe('toAcpPromptBlockFromAttachment', () => {
  it('keeps the attachment:// uri for an inline image with no local copy', () => {
    expect(toAcpPromptBlockFromAttachment({
      type: 'image',
      content: 'data:image/png;base64,QUJD',
      mimeType: 'image/png',
      name: 'shot.png',
    })).toEqual({
      type: 'image',
      data: 'QUJD',
      mimeType: 'image/png',
      uri: 'attachment://shot.png',
    });
  });

  it('references a durable local copy by an unencoded file:// uri, keeping the inline data', () => {
    const storedPath = '/Users/me/Library/Application Support/harness/acp-attachments/sess-1/abc-shot.png';

    expect(toAcpPromptBlockFromAttachment({
      type: 'image',
      content: 'data:image/png;base64,QUJD',
      mimeType: 'image/png',
      name: 'shot.png',
      path: storedPath,
    })).toEqual({
      type: 'image',
      data: 'QUJD',
      mimeType: 'image/png',
      // Not `Application%20Support`: Copilot resolves the uri without decoding.
      uri: `file://${storedPath}`,
    });
  });

  it('passes an existing file:// uri through unchanged', () => {
    const block = toAcpPromptBlockFromAttachment({
      type: 'image',
      content: 'QUJD',
      mimeType: 'image/png',
      path: 'file:///tmp/shot.png',
    });

    expect(block).toMatchObject({ type: 'image', uri: 'file:///tmp/shot.png' });
  });

  it('does not treat a data: path as a local copy', () => {
    const block = toAcpPromptBlockFromAttachment({
      type: 'image',
      path: 'data:image/png;base64,QUJD',
      name: 'shot.png',
    });

    expect(block).toEqual({
      type: 'image',
      data: 'QUJD',
      mimeType: 'image/png',
      uri: 'attachment://shot.png',
    });
  });
});
