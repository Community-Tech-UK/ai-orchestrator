import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import { isRendererEventSchemaRegistered, validateRendererEventPayload } from './renderer-event-validation';
describe('input-context delivery event contract', () => {
  it('registers the dedicated metadata channel and rejects invented measurements or unrelated fields', () => {
    const delivery = { instanceId: 'session', messageId: 'user', deliveryId: 'delivery', tokens: 120 };
    const channel = IPC_CHANNELS.INSTANCE_INPUT_CONTEXT_DELIVERED;
    expect(isRendererEventSchemaRegistered(channel)).toBe(true);
    expect(validateRendererEventPayload(channel, delivery)).toBe(true);
    expect(validateRendererEventPayload(channel, { ...delivery, tokens: null })).toBe(true);
    expect(validateRendererEventPayload(channel, { ...delivery, tokens: -1 })).toBe(false);
    expect(validateRendererEventPayload(channel, { ...delivery, tokens: Infinity })).toBe(false);
    expect(validateRendererEventPayload(channel, { ...delivery, messageId: '' })).toBe(false);
    expect(validateRendererEventPayload(channel, { ...delivery, content: 'Another user turn' })).toBe(false);
  });
});
