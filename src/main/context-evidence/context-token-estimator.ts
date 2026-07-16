export type ProviderTokenizer = (text: string) => number;

export interface ContextTokenEstimate {
  tokens: number;
  estimateKind: 'provider-tokenizer' | 'conservative-fallback';
}

/**
 * Provider-neutral counting seam. A provider tokenizer wins only when it
 * returns a finite, integral count; all other paths use an explicitly-labelled
 * UTF-8-aware conservative estimate.
 */
export class ContextTokenEstimator {
  constructor(private readonly providerTokenizer?: ProviderTokenizer) {}

  estimate(text: string): ContextTokenEstimate {
    if (this.providerTokenizer) {
      try {
        const tokens = this.providerTokenizer(text);
        if (
          Number.isSafeInteger(tokens)
          && tokens >= 0
          && (text.length === 0 || tokens > 0)
        ) {
          return { tokens, estimateKind: 'provider-tokenizer' };
        }
      } catch {
        // Provider tokenization is optional. The labelled fallback below is safe.
      }
    }

    return {
      tokens: Buffer.byteLength(text, 'utf8'),
      estimateKind: 'conservative-fallback',
    };
  }
}
