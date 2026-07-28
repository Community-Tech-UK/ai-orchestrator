import { describe, expect, it, vi } from 'vitest';
import { createInstanceWithMessage, logCreateWithMessageReceived } from './instance-create-with-message';
import type { SubsystemLogger } from '../../logging/logger';

function makeLogger() {
  const info = vi.fn();
  return { logger: { info } as unknown as SubsystemLogger, info };
}

describe('logCreateWithMessageReceived', () => {
  it('records the submission before validation can reject it', () => {
    // The 28 July loss could not be diagnosed because this channel logged
    // nothing on entry and swallowed Zod failures, so "never sent" and
    // "sent and rejected" looked identical in app.log.
    const { logger, info } = makeLogger();

    logCreateWithMessageReceived(logger, {
      workingDirectory: '/Users/suas/work/communitytech',
      message: 'x'.repeat(4321),
      idempotencyKey: 'sub-1',
      attachments: [
        { name: 'pasted-image-1.png', type: 'image/png', size: 1, data: 'a' },
        { name: 'pasted-image-2.png', type: 'image/png', size: 1, data: 'b' },
      ],
    });

    expect(info).toHaveBeenCalledWith('IPC INSTANCE_CREATE_WITH_MESSAGE received', {
      submissionId: 'sub-1',
      workingDirectory: '/Users/suas/work/communitytech',
      messageLength: 4321,
      attachmentsCount: 2,
      attachmentNames: ['pasted-image-1.png', 'pasted-image-2.png'],
    });
  });

  it('logs an over-cap attachment batch that Zod is about to reject', () => {
    const { logger, info } = makeLogger();

    logCreateWithMessageReceived(logger, {
      workingDirectory: '/repo',
      message: 'hi',
      attachments: Array.from({ length: 14 }, (_, i) => ({ name: `tile-${i}.webp` })),
    });

    expect(info.mock.calls[0][1]).toMatchObject({ attachmentsCount: 14 });
  });

  it('survives a malformed payload — it runs on unvalidated input', () => {
    const { logger, info } = makeLogger();

    expect(() => logCreateWithMessageReceived(logger, null)).not.toThrow();
    expect(() => logCreateWithMessageReceived(logger, 'nonsense')).not.toThrow();
    expect(() =>
      logCreateWithMessageReceived(logger, { attachments: [null, 7, { name: 'ok.png' }] }),
    ).not.toThrow();

    expect(info.mock.calls[0][1]).toMatchObject({
      submissionId: null,
      workingDirectory: null,
      messageLength: 0,
      attachmentsCount: 0,
    });
    expect(info.mock.calls[2][1]).toMatchObject({
      attachmentsCount: 3,
      attachmentNames: ['ok.png'],
    });
  });
});

describe('createInstanceWithMessage', () => {
  const attachments = [
    { name: 'pasted-image-1.png', type: 'image/png', size: 10, data: 'a' },
    { name: 'pasted-image-2.png', type: 'image/png', size: 10, data: 'b' },
  ];

  function makeManager(instance: unknown = { id: 'inst-1' }) {
    const createInstance = vi.fn().mockResolvedValue(instance);
    return { createInstance } as unknown as Parameters<typeof createInstanceWithMessage>[0] & {
      createInstance: ReturnType<typeof vi.fn>;
    };
  }

  it('forwards the message and attachments and seeds the initial output buffer', async () => {
    const manager = makeManager();

    const response = await createInstanceWithMessage(
      manager,
      { message: 'the long prompt', provider: 'claude', yoloMode: true },
      '/Users/suas/work/communitytech',
      attachments,
    );

    expect(response.success).toBe(true);
    const args = (manager as unknown as { createInstance: ReturnType<typeof vi.fn> })
      .createInstance.mock.calls[0][0];
    expect(args.workingDirectory).toBe('/Users/suas/work/communitytech');
    expect(args.initialPrompt).toBe('the long prompt');
    expect(args.attachments).toBe(attachments);
    expect(args.provider).toBe('claude');
    expect(args.yoloMode).toBe(true);
    // The first user turn must carry the images, or the transcript shows a
    // prompt with no screenshots attached.
    expect(args.initialOutputBuffer).toHaveLength(1);
    expect(args.initialOutputBuffer[0].attachments).toEqual(attachments);
  });

  it('propagates a creation failure rather than reporting success', async () => {
    const manager = makeManager();
    (manager as unknown as { createInstance: ReturnType<typeof vi.fn> }).createInstance
      .mockRejectedValue(new Error('spawn failed'));

    await expect(
      createInstanceWithMessage(manager, { message: 'hi' }, '/repo', undefined),
    ).rejects.toThrow('spawn failed');
  });
});
