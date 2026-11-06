import { describe, expect, it, vi } from 'vitest';
import { AcpCliAdapter } from './acp-cli-adapter';
import type { OutputMessage } from '../../../shared/types/instance.types';

describe('ACP visible errors and machine recovery evidence', () => {
  it('keeps raw provider failure only in Details while preserving the original error event and rejection', async () => {
    const adapter = new AcpCliAdapter({ workingDirectory: '/tmp/placeholder', concurrencyKey: 'cursor' });
    const failure = new Error('PRIVATE_PROVIDER_FAILURE_PLACEHOLDER');
    vi.spyOn(adapter, 'sendMessage').mockRejectedValue(failure);
    const messages: OutputMessage[] = [];
    const errors: unknown[] = [];
    adapter.on('output', message => messages.push(message));
    adapter.on('error', error => errors.push(error));
    const send = adapter as unknown as { sendInputImpl(message: string): Promise<void> };
    await expect(send.sendInputImpl('placeholder')).rejects.toBe(failure);
    expect(errors).toEqual([failure]);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).not.toContain(failure.message);
    expect(messages[0].metadata).toMatchObject({ source: 'acp-send-input', transport: 'acp', errorPresentation: { rawDetail: failure.message } });
  });
});
