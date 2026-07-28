import { describe, expect, it, vi } from 'vitest';
import { inputFilesToAttachments } from './instance-messaging-queue-utils';
import { FILE_LIMITS } from './instance.types';
import type { FileAttachment } from '../../../../../shared/types/instance.types';

function image(index: number): File {
  return new File([new Uint8Array(8)], `pasted-image-${index}.png`, { type: 'image/png' });
}

function tile(index: number): FileAttachment {
  return { name: `tile-${index}.webp`, type: 'image/webp', size: 100, data: 'x' };
}

function makeAdapter(perFile: FileAttachment[][]) {
  let call = 0;
  return {
    validateFiles: vi.fn(() => [] as string[]),
    fileToAttachments: vi.fn(async () => perFile[call++] ?? []),
  };
}

describe('inputFilesToAttachments', () => {
  it('returns the converted attachments when everything fits', async () => {
    const adapter = makeAdapter([[tile(1)], [tile(2)]]);
    const addError = vi.fn();

    const result = await inputFilesToAttachments('inst-1', [image(1), image(2)], 'send', adapter, addError);

    expect(result).toEqual([tile(1), tile(2)]);
    expect(addError).not.toHaveBeenCalled();
  });

  it('surfaces a validation failure instead of converting', async () => {
    const adapter = makeAdapter([]);
    adapter.validateFiles.mockReturnValue(['dump.bin is too large (40.0MB). Maximum size is 30MB.']);
    const addError = vi.fn();

    const result = await inputFilesToAttachments('inst-1', [image(1)], 'send', adapter, addError);

    expect(result).toBeNull();
    expect(adapter.fileToAttachments).not.toHaveBeenCalled();
    expect(addError).toHaveBeenCalledWith('inst-1', expect.stringContaining('too large'));
  });

  it('rejects a post-tiling attachment count the main process would silently drop', async () => {
    // Six tall screenshots tiling into twelve attachments: past
    // `InstanceSendInputPayloadSchema.attachments.max(10)` the main process
    // rejects the whole payload with nothing logged, which looks to the user
    // like the send simply vanished.
    const perFile = Array.from({ length: 6 }, (_, i) => [tile(i * 2), tile(i * 2 + 1)]);
    const adapter = makeAdapter(perFile);
    const addError = vi.fn();

    const result = await inputFilesToAttachments(
      'inst-1',
      Array.from({ length: 6 }, (_, i) => image(i)),
      'send',
      adapter,
      addError,
    );

    expect(result).toBeNull();
    const [, message] = addError.mock.calls[0];
    expect(message).toContain('Failed to send message');
    expect(message).toContain(`limit ${FILE_LIMITS.MAX_ATTACHMENTS}`);
    expect(message).toContain('6 file(s) expanded to 12');
  });

  it('names the steer action in the over-cap message', async () => {
    const adapter = makeAdapter(Array.from({ length: 11 }, (_, i) => [tile(i)]));
    const addError = vi.fn();

    await inputFilesToAttachments(
      'inst-1',
      Array.from({ length: 11 }, (_, i) => image(i)),
      'steer',
      adapter,
      addError,
    );

    expect(addError.mock.calls[0][1]).toContain('Failed to steer message');
  });

  it('reports a conversion throw rather than losing it', async () => {
    const adapter = {
      validateFiles: vi.fn(() => [] as string[]),
      fileToAttachments: vi.fn(async () => {
        throw new Error('File shot.png exceeds maximum size of 5MB');
      }),
    };
    const addError = vi.fn();

    const result = await inputFilesToAttachments('inst-1', [image(1)], 'send', adapter, addError);

    expect(result).toBeNull();
    expect(addError).toHaveBeenCalledWith(
      'inst-1',
      expect.stringContaining('exceeds maximum size of 5MB'),
    );
  });
});
