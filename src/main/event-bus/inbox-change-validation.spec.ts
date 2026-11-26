import { describe, expect, it, vi } from 'vitest';
import { sendValidatedRendererEvent } from './renderer-event-validation';

describe('inbox change renderer validation', () => {
  it.each(['memory-review:changed', 'repo-job:changed'])('drops malformed %s pushes before delivery', channel => {
    const sender = { send: vi.fn() };
    expect(sendValidatedRendererEvent(sender, channel, { changedAt: 'invalid' })).toBe(false);
    expect(sender.send).not.toHaveBeenCalled();
    expect(sendValidatedRendererEvent(sender, channel, { changedAt: 123 })).toBe(true);
    expect(sender.send).toHaveBeenCalledOnce();
    expect(sendValidatedRendererEvent(sender, channel, { changedAt: 123, proposal: 'EXAMPLE_PRIVATE_CONTENT' })).toBe(false);
    expect(sender.send).toHaveBeenCalledOnce();
  });
});
