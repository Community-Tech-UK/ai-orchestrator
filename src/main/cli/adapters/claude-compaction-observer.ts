import type { CliSystemMessage } from '../../../shared/types/cli.types';

/** Provider evidence is scoped to a turn; metadata never substitutes for a boundary. */
export class ClaudeCompactionObserver {
  private turn: { count: number; trigger?: string; preTokens?: number; postTokens?: number } = { count: 0 };
  private readonly listeners = new Set<() => void>();

  reset(): void { this.turn = { count: 0 }; }
  getTurnCompaction(): Readonly<typeof this.turn> { return { ...this.turn }; }
  onCompactionObserved(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  }
  observe(message: CliSystemMessage): void {
    if (message.subtype !== 'compact_boundary') return;
    const metadata = message.compact_metadata;
    this.turn = {
      count: this.turn.count + 1,
      ...(typeof metadata?.trigger === 'string' ? { trigger: metadata.trigger } : {}),
      ...(typeof metadata?.pre_tokens === 'number' && Number.isFinite(metadata.pre_tokens) && metadata.pre_tokens >= 0
        ? { preTokens: metadata.pre_tokens } : {}),
      ...(typeof metadata?.post_tokens === 'number' && Number.isFinite(metadata.post_tokens) && metadata.post_tokens >= 0
        ? { postTokens: metadata.post_tokens } : {}),
    };
    for (const callback of this.listeners) callback();
  }
}
