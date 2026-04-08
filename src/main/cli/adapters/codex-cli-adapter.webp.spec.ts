import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';

import { CodexCliAdapter } from './codex-cli-adapter';

describe('CodexCliAdapter webp attachments', () => {
  it('falls back to file references for unsupported webp images', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codex-adapter-webp-'));

    try {
      const adapter = new CodexCliAdapter({ workingDir: tempDir });
      const prepared = await (adapter as unknown as {
        prepareMessage(message: {
          attachments: { content: string; mimeType: string; name: string; type: 'file' | 'image' }[];
          content: string;
          role: 'user';
        }): Promise<{ attachments?: { path?: string; type: string }[]; content: string }>;
      }).prepareMessage({
        role: 'user',
        content: 'Inspect this screenshot',
        attachments: [
          {
            type: 'image',
            name: 'screenshot.webp',
            mimeType: 'image/webp',
            content: Buffer.from('fake-image').toString('base64'),
          },
        ],
      });

      expect(prepared.attachments).toBeUndefined();
      expect(prepared.content).toContain('[Attached image:');
      expect(prepared.content).toContain('screenshot.webp');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
