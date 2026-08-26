import { describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildExistingSessionContext } from './loop-existing-session-context';

function message(id: string, type: OutputMessage['type'], content: string, timestamp = 1): OutputMessage {
  return { id, type, content, timestamp } as OutputMessage;
}

function managerFor(instance: Partial<Instance> | undefined) {
  return { getInstance: () => instance } as unknown as Parameters<typeof buildExistingSessionContext>[0];
}

describe('buildExistingSessionContext', () => {
  it('returns undefined when the session has no output', () => {
    expect(buildExistingSessionContext(managerFor({ outputBuffer: [] }), 'chat-1')).toBeUndefined();
  });

  it('anchors an opening prompt that a trim already evicted from the buffer', () => {
    const context = buildExistingSessionContext(
      managerFor({
        outputBuffer: [
          message('u9', 'user', 'carry on', 20),
          message('a9', 'assistant', 'carrying on', 21),
        ],
        retainedPrompts: [message('p0', 'user', 'Migrate the billing service.', 1)],
      }),
      'chat-1',
    );

    expect(context).toContain('Original request:');
    expect(context).toContain('Migrate the billing service.');
  });
});
