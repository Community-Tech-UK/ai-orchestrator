/**
 * Token Counter Utility
 * Provides accurate token counting for various LLM providers
 *
 * Uses a tiktoken-compatible approach for OpenAI models and
 * provider-specific estimations for Claude and other models.
 *
 * Supports hybrid counting: heuristic estimates are calibrated against
 * actual API usage data when available (via `calibrate()`), and a
 * configurable safety margin prevents overflow from estimation errors.
 */

import { LIMITS } from '../../shared/constants/limits';
import {
  countSpecialTokens,
  getModelFamily,
  isLikelyCode,
  lookupPricing,
  MODEL_PATTERNS,
} from './token-counter-config';

export { getModelFamily } from './token-counter-config';

export type ModelFamily = 'gpt-4' | 'gpt-3.5' | 'claude' | 'llama' | 'unknown';

/**
 * Per-component token breakdown for targeted compaction decisions.
 * Inspired by Copilot SDK's systemTokens/conversationTokens/toolDefinitionsTokens split.
 */
export interface TokenBreakdown {
  /** Tokens consumed by system prompt(s) */
  system: number;
  /** Tokens consumed by user/assistant conversation turns */
  conversation: number;
  /** Tokens consumed by tool definitions (schemas, descriptions) */
  toolDefinitions: number;
  /** Tokens consumed by tool call results in history */
  toolResults: number;
  /** Tokens consumed by attachments (images, documents) */
  attachments: number;
  /** Grand total */
  total: number;
}

/**
 * Calibration data from actual API responses.
 * Stores actual vs. estimated ratios to auto-correct heuristic drift.
 */
interface CalibrationEntry {
  actualTokens: number;
  estimatedTokens: number;
  model: string;
  timestamp: number;
}

/** Maximum calibration samples to retain per model family */
const MAX_CALIBRATION_SAMPLES = 20;

/**
 * A single estimate-vs-actual observation for drift telemetry.
 * `estimated` is the raw (unpadded, uncalibrated) heuristic count for the same
 * text the provider reported `actual` tokens for.
 */
interface EstimationSample {
  estimated: number;
  actual: number;
  timestamp: number;
}

/** Maximum estimate-vs-actual telemetry samples to retain per model family. */
const MAX_TELEMETRY_SAMPLES = 50;

/**
 * Aggregate estimate-vs-actual drift statistics for one model family.
 *
 * This is pure observability — it reports how far the heuristic estimator
 * drifts from real provider token counts, WITHOUT changing any count. It is the
 * evidence an operator/developer inspects before deciding whether enabling
 * calibration (which DOES mutate counts) is warranted.
 */
export interface EstimationTelemetry {
  /** The model family these stats are aggregated over. */
  family: ModelFamily;
  /** Number of paired (estimated, actual) samples recorded. */
  sampleCount: number;
  /**
   * Median of `actual / estimated` across samples. `> 1` means the heuristic
   * systematically UNDER-counts (real tokens exceed the estimate); `< 1` means
   * it over-counts. `1` is perfectly calibrated.
   */
  medianRatio: number;
  /**
   * Mean absolute percentage error of the heuristic vs the provider actual:
   * `mean(|actual - estimated| / actual) * 100`. Lower is better.
   */
  meanAbsErrorPct: number;
  /** Epoch-ms timestamp of the most recent sample. */
  lastSampleAt: number;
}

/**
 * TokenCounter - Utility class for accurate token counting
 */
export class TokenCounter {
  private static instance: TokenCounter | null = null;
  private modelFamily: ModelFamily = 'unknown';

  /** Safety margin applied to all heuristic estimates (default from LIMITS) */
  private safetyMargin: number = LIMITS.TOKEN_SAFETY_MARGIN;

  /**
   * Guards whether `calibrate()` actually records data.
   *
   * Defaults to **false** because no currently-wired call site supplies a
   * genuinely-paired (estimated-text, actual-provider-tokens) value for the
   * same text/turn.  Feeding mismatched pairs would silently corrupt the
   * correction factor that drives `countTokens()`.
   *
   * Set to `true` only once a call site has been audited to confirm:
   *   1. `text` is the exact content that was tokenized by the provider.
   *   2. `actualTokens` is the provider-reported count for that same content.
   *   3. No other content (system prompt, history, tool definitions) is
   *      included in `actualTokens`.
   */
  private calibrateTokenCounts = false;

  /** Calibration data from actual API responses, keyed by ModelFamily */
  private calibrationData = new Map<ModelFamily, CalibrationEntry[]>();

  /** Derived correction factors from calibration (actual/estimated ratio) */
  private correctionFactors = new Map<ModelFamily, number>();

  /**
   * Estimate-vs-actual telemetry, keyed by ModelFamily.
   *
   * UNLIKE calibration, this is recorded **unconditionally** (no gate): it only
   * *observes* drift and never feeds back into `countTokens()`, so it cannot
   * corrupt anything. It is the diagnostic evidence used to decide whether
   * enabling calibration would actually help (and in which direction).
   */
  private estimationSamples = new Map<ModelFamily, EstimationSample[]>();

  // Private constructor for singleton pattern
  private constructor() {
    // Intentionally empty - initialization happens via setModelFamily()
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): TokenCounter {
    if (!this.instance) {
      this.instance = new TokenCounter();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.calibrationData.clear();
      this.instance.correctionFactors.clear();
      this.instance.estimationSamples.clear();
      this.instance.calibrateTokenCounts = false;
    }
    this.instance = null;
  }

  /**
   * Set the default model family for counting
   */
  setDefaultModel(model?: string): void {
    this.modelFamily = getModelFamily(model);
  }

  /**
   * Count tokens in a text string
   * Uses model-specific heuristics for accurate estimation.
   *
   * Applies:
   * 1. Model-specific char-per-token ratios
   * 2. Calibration correction factor (if API data has been fed via `calibrate()`)
   * 3. Safety margin (default 1.15x) to prevent overflow from estimation errors
   *
   * @param text - The text to count tokens for
   * @param model - Optional model identifier to use specific tokenization rules
   * @returns Estimated token count (conservative — always rounds up)
   */
  countTokens(text: string, model?: string): number {
    if (!text) return 0;

    const rawEstimate = this.countTokensRaw(text, model);

    // Apply calibration correction if available
    const family = model ? getModelFamily(model) : this.modelFamily;
    const correction = this.correctionFactors.get(family) ?? 1.0;

    // Apply safety margin on top of calibration-corrected estimate
    return Math.max(1, Math.ceil(rawEstimate * correction * this.safetyMargin));
  }

  /**
   * Raw token estimate WITHOUT safety margin or calibration.
   * Use this for internal calculations where you need the unpadded estimate
   * (e.g., computing calibration corrections, cost estimation).
   */
  countTokensRaw(text: string, model?: string): number {
    if (!text) return 0;

    const family = model ? getModelFamily(model) : this.modelFamily;
    const pattern = MODEL_PATTERNS[family];

    // Base calculation
    const isCode = isLikelyCode(text);
    const multiplier = isCode ? pattern.codeMultiplier : 1.0;

    // Count characters excluding pure whitespace sequences
    const contentChars = text.replace(/\s+/g, ' ').length;

    // Account for whitespace that may merge with tokens
    const whitespaceCount = (text.match(/\s/g) || []).length;
    const effectiveWhitespace = Math.floor(whitespaceCount * pattern.whitespaceWeight);

    // Calculate base tokens
    const baseTokens = (contentChars - effectiveWhitespace) / pattern.avgCharsPerToken;

    // Add special tokens
    const specialTokens = countSpecialTokens(text);

    // Apply code multiplier and round
    const totalTokens = Math.ceil((baseTokens + specialTokens) * multiplier);

    // Ensure minimum of 1 token for non-empty strings
    return Math.max(1, totalTokens);
  }

  /**
   * Enable or disable calibration data recording.
   *
   * Calibration is **disabled by default** (`calibrateTokenCounts = false`).
   * Enable it only when `calibrate()` is wired to a site that supplies a
   * genuinely-paired (estimated-text, provider-actual-tokens) value — meaning
   * `actualTokens` comes from the provider's response for *exactly* `text`,
   * with no other content folded into the count.
   */
  setCalibrateTokenCounts(enabled: boolean): void {
    this.calibrateTokenCounts = enabled;
  }

  /**
   * Whether calibration recording is currently enabled.
   */
  getCalibrateTokenCounts(): boolean {
    return this.calibrateTokenCounts;
  }

  /**
   * Calibrate the estimator with actual API usage data.
   *
   * Feed this function the actual token count returned by the API alongside
   * the text that was sent. Over time, the correction factor converges on
   * the true ratio between heuristic estimates and actual tokenizer output.
   *
   * Inspired by OpenClaw's SAFETY_MARGIN and Actual Claude's hybrid
   * tokenCountWithEstimation approach.
   *
   * NOTE: This method is a no-op unless `setCalibrateTokenCounts(true)` has
   * been called.  The guard prevents accidentally corrupting the correction
   * factor with mismatched (estimated-text, actual-tokens) pairs.
   */
  calibrate(actualTokens: number, text: string, model?: string): void {
    if (!this.calibrateTokenCounts) return;

    const family = model ? getModelFamily(model) : this.modelFamily;
    const estimated = this.countTokensRaw(text, model);

    if (estimated === 0 || actualTokens === 0) return;

    const samples = this.calibrationData.get(family) ?? [];
    samples.push({ actualTokens, estimatedTokens: estimated, model: model ?? '', timestamp: Date.now() });

    // Keep only the most recent samples
    if (samples.length > MAX_CALIBRATION_SAMPLES) {
      samples.splice(0, samples.length - MAX_CALIBRATION_SAMPLES);
    }
    this.calibrationData.set(family, samples);

    // Recompute correction factor as median(actual/estimated) across samples
    const ratios = samples.map(s => s.actualTokens / s.estimatedTokens).sort((a, b) => a - b);
    const mid = Math.floor(ratios.length / 2);
    const median = ratios.length % 2 === 0
      ? (ratios[mid - 1] + ratios[mid]) / 2
      : ratios[mid];

    // Clamp correction to reasonable range [0.5, 2.0] to prevent wild swings
    this.correctionFactors.set(family, Math.max(0.5, Math.min(2.0, median)));
  }

  /**
   * Get the current correction factor for a model family.
   * Returns 1.0 if no calibration data is available.
   */
  getCorrectionFactor(model?: string): number {
    const family = model ? getModelFamily(model) : this.modelFamily;
    return this.correctionFactors.get(family) ?? 1.0;
  }

  /**
   * Record one estimate-vs-actual telemetry sample.
   *
   * Feed this the provider-reported token count (`actualTokens`) alongside the
   * EXACT text that count was for (e.g. a completion's output text paired with
   * its `output_tokens`). It computes the raw heuristic estimate for the same
   * text and stores the pair so {@link getEstimationTelemetry} can report drift.
   *
   * This is intentionally **ungated** and side-effect-free with respect to
   * counting: it never changes `countTokens()` output. Mismatched or zero
   * inputs are dropped rather than recorded.
   *
   * @returns `true` if the sample was recorded, `false` if it was dropped as
   *   invalid (empty text, non-positive actual, or zero estimate).
   */
  recordEstimationSample(actualTokens: number, text: string, model?: string): boolean {
    if (!text || !Number.isFinite(actualTokens) || actualTokens <= 0) return false;

    const estimated = this.countTokensRaw(text, model);
    if (estimated <= 0) return false;

    const family = model ? getModelFamily(model) : this.modelFamily;
    const samples = this.estimationSamples.get(family) ?? [];
    samples.push({ estimated, actual: actualTokens, timestamp: Date.now() });

    // Keep only the most recent samples (bounded memory).
    if (samples.length > MAX_TELEMETRY_SAMPLES) {
      samples.splice(0, samples.length - MAX_TELEMETRY_SAMPLES);
    }
    this.estimationSamples.set(family, samples);
    return true;
  }

  /**
   * Aggregate estimate-vs-actual drift stats for a model family, or `null` if
   * no telemetry has been recorded for it yet.
   */
  getEstimationTelemetry(model?: string): EstimationTelemetry | null {
    const family = model ? getModelFamily(model) : this.modelFamily;
    const samples = this.estimationSamples.get(family);
    if (!samples || samples.length === 0) return null;

    const ratios = samples.map((s) => s.actual / s.estimated).sort((a, b) => a - b);
    const mid = Math.floor(ratios.length / 2);
    const medianRatio = ratios.length % 2 === 0
      ? (ratios[mid - 1] + ratios[mid]) / 2
      : ratios[mid];

    const meanAbsErrorPct =
      (samples.reduce((sum, s) => sum + Math.abs(s.actual - s.estimated) / s.actual, 0) /
        samples.length) * 100;

    return {
      family,
      sampleCount: samples.length,
      medianRatio,
      meanAbsErrorPct,
      lastSampleAt: samples[samples.length - 1].timestamp,
    };
  }

  /**
   * Aggregate estimate-vs-actual drift stats for every family that has
   * telemetry, keyed by family. Useful for a diagnostics surface.
   */
  getAllEstimationTelemetry(): Partial<Record<ModelFamily, EstimationTelemetry>> {
    const out: Partial<Record<ModelFamily, EstimationTelemetry>> = {};
    for (const family of this.estimationSamples.keys()) {
      const telemetry = this.getEstimationTelemetry(family);
      if (telemetry) out[family] = telemetry;
    }
    return out;
  }

  /**
   * Set a custom safety margin (default is LIMITS.TOKEN_SAFETY_MARGIN = 1.15).
   * Pass 1.0 to disable the safety margin.
   */
  setSafetyMargin(margin: number): void {
    this.safetyMargin = Math.max(1.0, margin); // Floor at 1.0 — never undercount
  }

  /**
   * Compute a per-component token breakdown for targeted compaction.
   * Categorizes message components so compaction can target the heaviest section.
   */
  computeBreakdown(components: {
    systemPrompt?: string;
    conversationTurns?: string[];
    toolDefinitions?: string;
    toolResults?: string[];
    attachments?: string[];
  }, model?: string): TokenBreakdown {
    const count = (text?: string) => text ? this.countTokens(text, model) : 0;
    const countAll = (texts?: string[]) => (texts ?? []).reduce((sum, t) => sum + this.countTokens(t, model), 0);

    const system = count(components.systemPrompt);
    const conversation = countAll(components.conversationTurns);
    const toolDefinitions = count(components.toolDefinitions);
    const toolResults = countAll(components.toolResults);
    const attachments = countAll(components.attachments);

    return {
      system,
      conversation,
      toolDefinitions,
      toolResults,
      attachments,
      total: system + conversation + toolDefinitions + toolResults + attachments,
    };
  }

  /**
   * Truncate text to fit within a token limit
   * Attempts to truncate at natural boundaries (sentences, words)
   *
   * @param text - The text to truncate
   * @param maxTokens - Maximum number of tokens allowed
   * @param model - Optional model identifier
   * @returns Truncated text that fits within the token limit
   */
  truncateToTokens(text: string, maxTokens: number, model?: string): string {
    if (!text) return '';

    const currentTokens = this.countTokens(text, model);
    if (currentTokens <= maxTokens) {
      return text;
    }

    const family = model ? getModelFamily(model) : this.modelFamily;
    const pattern = MODEL_PATTERNS[family];

    // Estimate chars to keep (with buffer)
    const targetChars = Math.floor(maxTokens * pattern.avgCharsPerToken * 0.95);

    // Try to truncate at sentence boundary
    let truncated = text.slice(0, targetChars);
    const lastSentence = truncated.search(/[.!?]\s+[A-Z][^.!?]*$/);

    if (lastSentence > targetChars * 0.5) {
      truncated = truncated.slice(0, lastSentence + 1);
    } else {
      // Fall back to word boundary
      const lastSpace = truncated.lastIndexOf(' ');
      if (lastSpace > targetChars * 0.7) {
        truncated = truncated.slice(0, lastSpace);
      }
    }

    // Verify token count and adjust if needed
    let finalTokens = this.countTokens(truncated, model);
    while (finalTokens > maxTokens && truncated.length > 10) {
      // Remove more content
      const removeChars = Math.ceil((finalTokens - maxTokens) * pattern.avgCharsPerToken);
      truncated = truncated.slice(0, -removeChars);

      // Try to end at word boundary
      const lastSpace = truncated.lastIndexOf(' ');
      if (lastSpace > truncated.length * 0.8) {
        truncated = truncated.slice(0, lastSpace);
      }

      finalTokens = this.countTokens(truncated, model);
    }

    return truncated + (truncated.length < text.length ? '...' : '');
  }

  /**
   * Split text into chunks that fit within a token limit
   * Useful for processing large documents
   *
   * @param text - The text to split
   * @param maxTokensPerChunk - Maximum tokens per chunk
   * @param overlap - Number of tokens to overlap between chunks (for context)
   * @param model - Optional model identifier
   * @returns Array of text chunks
   */
  splitIntoChunks(
    text: string,
    maxTokensPerChunk: number,
    overlap = 0,
    model?: string
  ): string[] {
    if (!text) return [];

    const totalTokens = this.countTokens(text, model);
    if (totalTokens <= maxTokensPerChunk) {
      return [text];
    }

    const chunks: string[] = [];
    const family = model ? getModelFamily(model) : this.modelFamily;
    // Pattern available for future tokenization optimizations
    void MODEL_PATTERNS[family];

    // Split by paragraphs first
    const paragraphs = text.split(/\n\n+/);
    let currentChunk = '';
    let currentTokens = 0;

    for (const paragraph of paragraphs) {
      const paragraphTokens = this.countTokens(paragraph, model);

      if (currentTokens + paragraphTokens <= maxTokensPerChunk) {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
        currentTokens += paragraphTokens;
      } else {
        // Save current chunk if non-empty
        if (currentChunk) {
          chunks.push(currentChunk);

          // Handle overlap
          if (overlap > 0) {
            const overlapText = this.truncateToTokens(currentChunk, overlap, model);
            currentChunk = overlapText + '\n\n' + paragraph;
            currentTokens = this.countTokens(currentChunk, model);
          } else {
            currentChunk = paragraph;
            currentTokens = paragraphTokens;
          }
        } else {
          // Paragraph itself is too large, need to split it
          const subChunks = this.splitLargeParagraph(paragraph, maxTokensPerChunk, model);
          chunks.push(...subChunks.slice(0, -1));
          currentChunk = subChunks[subChunks.length - 1] || '';
          currentTokens = this.countTokens(currentChunk, model);
        }
      }
    }

    // Don't forget the last chunk
    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Split a large paragraph into smaller chunks
   */
  private splitLargeParagraph(
    paragraph: string,
    maxTokens: number,
    model?: string
  ): string[] {
    const chunks: string[] = [];
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    let currentChunk = '';
    let currentTokens = 0;

    for (const sentence of sentences) {
      const sentenceTokens = this.countTokens(sentence, model);

      if (currentTokens + sentenceTokens <= maxTokens) {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
        currentTokens += sentenceTokens;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
        }

        if (sentenceTokens <= maxTokens) {
          currentChunk = sentence;
          currentTokens = sentenceTokens;
        } else {
          // Sentence is too long, split by words
          const truncated = this.truncateToTokens(sentence, maxTokens, model);
          chunks.push(truncated);
          currentChunk = '';
          currentTokens = 0;
        }
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks.length > 0 ? chunks : [paragraph.slice(0, 100)];
  }

  /**
   * Estimate the cost of tokens for a given model.
   * Uses raw token counts (not safety-padded) since costs should reflect
   * actual expected usage, not worst-case estimates.
   *
   * @param inputTokens - Number of input tokens (actual or estimated)
   * @param outputTokens - Number of output tokens (actual or estimated)
   * @param model - Model identifier
   * @returns Estimated cost in USD
   */
  estimateCost(inputTokens: number, outputTokens: number, model?: string): number {
    const price = lookupPricing(model);
    const inputCost = (inputTokens / 1_000_000) * price.input;
    const outputCost = (outputTokens / 1_000_000) * price.output;
    return inputCost + outputCost;
  }
}

/**
 * Get the singleton TokenCounter instance
 */
export function getTokenCounter(): TokenCounter {
  return TokenCounter.getInstance();
}

/**
 * Convenience helper for one-off token estimation.
 */
export function estimateTokens(text: string, model?: string): number {
  return getTokenCounter().countTokens(text, model);
}
