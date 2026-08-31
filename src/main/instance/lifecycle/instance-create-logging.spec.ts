import { describe, expect, it } from 'vitest';

import { summarizeCreateInstanceConfig } from './instance-create-logging';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';

describe('summarizeCreateInstanceConfig', () => {
  it('redacts attachment data and summarizes seeded output', () => {
    const config: InstanceCreateConfig = {
      workingDirectory: '/repo',
      displayName: 'Test session',
      initialPrompt: 'A'.repeat(300),
      attachments: [
        { name: 'secret.png', type: 'image/png', size: 12, data: 'base64-secret' },
      ],
      initialOutputBuffer: [
        { id: 'msg-1', timestamp: 1, type: 'user', content: 'hello' },
      ],
    };

    const summary = summarizeCreateInstanceConfig(config);

    expect(summary['initialPromptPreview']).toContain('... (300 chars)');
    expect(summary['attachments']).toEqual([
      { name: 'secret.png', type: 'image/png', size: 12, dataLength: 13 },
    ]);
    expect(summary['initialOutputBuffer']).toEqual(expect.objectContaining({
      count: 1,
      totalContentLength: 5,
      totalAttachmentCount: 0,
    }));
  });

  it('omits a crash-recovery resume cursor from lifecycle diagnostics', () => {
    const summary = summarizeCreateInstanceConfig({
      workingDirectory: '/repo',
      sessionId: 'cursor-fixture-placeholder',
      historyThreadId: 'history-thread-fixture-placeholder',
      resume: true,
      metadata: { reason: 'crash-recovery' },
    });

    expect(summary['sessionId']).toBe('[recovery session omitted]');
    expect(JSON.stringify(summary)).not.toContain('cursor-fixture-placeholder');
    expect(JSON.stringify(summary)).not.toContain('history-thread-fixture-placeholder');
  });
});
