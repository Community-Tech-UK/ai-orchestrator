import { describe, expect, it } from 'vitest';
import { createCodexAdapter, createCliAdapter } from '../adapter-factory';

describe('adapter factory - codex', () => {
  it('maps yolo Codex instances to danger-full-access sandbox', () => {
    const adapter = createCodexAdapter({
      workingDirectory: '/tmp',
      yoloMode: true,
    });

    expect((adapter as unknown as {
      cliConfig: { approvalMode?: string; sandboxMode?: string };
    }).cliConfig).toMatchObject({
      approvalMode: 'full-auto',
      sandboxMode: 'danger-full-access',
    });
  });

  it('keeps non-yolo Codex instances read-only', () => {
    const adapter = createCliAdapter('codex', {
      workingDirectory: '/tmp',
      yoloMode: false,
    });

    expect((adapter as unknown as {
      cliConfig: { approvalMode?: string; sandboxMode?: string };
    }).cliConfig).toMatchObject({
      approvalMode: 'suggest',
      sandboxMode: 'read-only',
    });
  });
});
