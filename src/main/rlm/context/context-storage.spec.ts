import { describe, expect, it, vi } from 'vitest';
import type { ContextStore } from '../../../shared/types/rlm.types';
import { addSection, type StorageDependencies } from './context-storage';

const PRIVATE_KEY_HEADER = '-----BEGIN PRIVATE KEY----- EXAMPLE ONLY';

describe('context-storage secret egress gate', () => {
  it('redacts a secret before a context section is persisted or indexed', () => {
    const persisted: { content: string }[] = [];
    const indexed = vi.fn().mockResolvedValue(undefined);
    const store: ContextStore = {
      id: 'store-1', instanceId: 'instance-1', sections: [], totalTokens: 0, totalSize: 0,
      createdAt: 1, lastAccessed: 1, accessCount: 0,
    };
    const deps: StorageDependencies = {
      db: { addSection: (section: { content: string }) => persisted.push(section) } as never,
      vectorStore: { addSection: indexed } as never,
      persistenceEnabled: true,
      maxSectionTokens: 8_000,
      summaryThreshold: 50_000,
      tokenEstimator: (content) => content.length,
    };

    const section = addSection(
      store,
      'conversation',
      'Customer report',
      `The leaked credential marker is ${PRIVATE_KEY_HEADER}.`,
      undefined,
      deps,
    );

    expect(section.content).toContain('[REDACTED — potential secret]');
    expect(section.content).not.toContain(PRIVATE_KEY_HEADER);
    expect(persisted).toEqual([expect.objectContaining({ content: section.content })]);
    expect(indexed).toHaveBeenCalledWith('store-1', section.id, section.content, expect.any(Object));
  });
});
