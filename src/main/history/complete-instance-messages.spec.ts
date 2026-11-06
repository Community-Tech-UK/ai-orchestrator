import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
const storage = vi.hoisted(() => ({ flushInstance: vi.fn(async () => undefined), loadMessages: vi.fn(async (): Promise<OutputMessage[]> => []) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => storage }));
import { recordToolOutcome, _resetToolOutcomeStoreForTesting } from '../learning/tool-outcome-store';
import { getCompleteInstanceMessages } from './complete-instance-messages';
describe('complete instance messages', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetToolOutcomeStoreForTesting(); });
  it('deduplicates renumbered prompts and retains invisible archive outcomes in time order', async () => {
    const opening: OutputMessage = { id: 'disk-id', timestamp: 1, type: 'user', content: 'Opening request' };
    storage.loadMessages.mockResolvedValue([opening]);
    recordToolOutcome('source', { id: 'outcome', timestamp: 2, type: 'tool_outcome', content: '' });
    const result = await getCompleteInstanceMessages({ id: 'source', retainedPrompts: [{ ...opening, id: 'wake-id' }], outputBuffer: [{ id: 'latest', timestamp: 3, type: 'assistant', content: 'Answer' }] } as Instance);
    expect(storage.flushInstance).toHaveBeenCalledWith('source');
    expect(result.map((i) => i.id)).toEqual(['disk-id', 'outcome', 'latest']);
  });
});
