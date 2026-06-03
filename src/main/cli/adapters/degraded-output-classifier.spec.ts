/**
 * Tests for the A3 degraded-output classifier.
 *
 * Coverage:
 *   - Each DegradedReason is reachable from representative signals
 *   - Several healthy-stream patterns do NOT produce a degraded verdict
 *     (false-positive guard — the primary hazard)
 *   - Priority ordering of reasons (cancelled wins over duplicate, etc.)
 *   - Edge cases: zero content, borderline thresholds, missing optional fields
 *   - Flag-off path: tagResponseIfEnabled leaves CliResponse untagged when
 *     detectDegradedAdapterOutput is false
 *   - Flag-on path: tagResponseIfEnabled tags the response when classifier fires
 */

import { describe, expect, it, vi } from 'vitest';
import {
  classifyDegradedOutput,
  type DegradedOutputSignals,
} from './degraded-output-classifier';
import { BaseCliAdapter, type CliResponse, type CliCapabilities } from './base-cli-adapter';
import type { CliStatus } from './base-cli-adapter';

// Mock the logger to avoid side-effects
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// TestAdapter helper — minimal concrete subclass for testing protected methods.
// Overrides isDegradedDetectionEnabled() so tests don't need to touch
// SettingsManager (avoids CommonJS require() interception issues with Vitest).
// ---------------------------------------------------------------------------

function makeAdapter(flagEnabled: boolean): TestAdapter {
  return new TestAdapter({ command: 'echo' }, flagEnabled);
}

class TestAdapter extends BaseCliAdapter {
  constructor(
    config: ConstructorParameters<typeof BaseCliAdapter>[0],
    private readonly _flagEnabled: boolean,
  ) {
    super(config);
  }

  // Override to inject flag value without touching SettingsManager
  protected override isDegradedDetectionEnabled(): boolean {
    return this._flagEnabled;
  }

  getName(): string { return 'test'; }

  getCapabilities(): CliCapabilities {
    return {
      streaming: false, toolUse: false, fileAccess: false,
      shellExecution: false, multiTurn: false, vision: false,
      codeExecution: false, contextWindow: 0, outputFormats: [],
    };
  }

  checkStatus(): Promise<CliStatus> {
    return Promise.resolve({ available: true });
  }

  sendMessage(): Promise<CliResponse> {
    return Promise.resolve({ id: '1', content: '', role: 'assistant' });
  }

  sendMessageStream(): AsyncIterable<string> {
    return { [Symbol.asyncIterator]: async function*() { /* stub */ } };
  }

  parseOutput(): CliResponse {
    return { id: '1', content: '', role: 'assistant' };
  }

  protected buildArgs(): string[] { return []; }
  protected sendInputImpl(): Promise<void> { return Promise.resolve(); }

  /** Expose the protected method for white-box testing. */
  callTagResponse(response: CliResponse, signals: DegradedOutputSignals): void {
    this.tagResponseIfEnabled(response, signals);
  }

  /** Expose protected state fields for inspection. */
  get testResponseStartedAt(): number { return this.responseStartedAt; }
  get testStreamIdleDidFire(): boolean { return this.streamIdleDidFire; }
}

// ---------------------------------------------------------------------------
// Pure classifier tests
// ---------------------------------------------------------------------------

/**
 * Build a minimal healthy-signal baseline. Tests override individual fields
 * to trigger specific classifications.
 */
function healthy(overrides: Partial<DegradedOutputSignals> = {}): DegradedOutputSignals {
  return {
    contentLength: 1_200,
    elapsedMs: 3_000,
    streamIdleFired: false,
    cancelled: false,
    duplicateOfPrior: false,
    ...overrides,
  };
}

describe('classifyDegradedOutput – healthy signals (false-positive guard)', () => {
  it('does not flag a normal, fast, content-rich response', () => {
    const result = classifyDegradedOutput(healthy());
    expect(result.degraded).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('does not flag a slow but content-rich response (long-running task)', () => {
    // 90 seconds but with substantial output
    const result = classifyDegradedOutput(
      healthy({ elapsedMs: 90_000, contentLength: 5_000 }),
    );
    expect(result.degraded).toBe(false);
  });

  it('does not flag a short but valid response under the delay threshold', () => {
    // 3 chars, 2 s — too short to be meaningful but also too fast to be delayed
    const result = classifyDegradedOutput(
      healthy({ contentLength: 3, elapsedMs: 2_000 }),
    );
    expect(result.degraded).toBe(false);
  });

  it('does not flag near-zero emptiness ratio content', () => {
    const result = classifyDegradedOutput(
      healthy({ contentLength: 500, emptinessRatio: 0.1 }),
    );
    expect(result.degraded).toBe(false);
  });

  it('does not flag moderate similarity to prior response', () => {
    // 0.8 similarity — common in follow-up answers that repeat some phrasing
    const result = classifyDegradedOutput(
      healthy({ similarityToPrior: 0.8 }),
    );
    expect(result.degraded).toBe(false);
  });

  it('does not flag a stream-idle fire when content is substantial', () => {
    // Idle fired (maybe a pause) but then substantial content arrived afterward
    const result = classifyDegradedOutput(
      healthy({ streamIdleFired: true, contentLength: 2_000 }),
    );
    expect(result.degraded).toBe(false);
  });

  it('does not flag zero content with undefined emptinessRatio (no ratio possible)', () => {
    // contentLength 0 with emptinessRatio undefined — the caller skips ratio
    // computation when length is 0 so we must not misfire here
    const result = classifyDegradedOutput(
      healthy({ contentLength: 0, elapsedMs: 100, emptinessRatio: undefined }),
    );
    expect(result.degraded).toBe(false);
  });

  it('does not flag undefined similarity (caller did not measure)', () => {
    const result = classifyDegradedOutput(
      healthy({ similarityToPrior: undefined }),
    );
    expect(result.degraded).toBe(false);
  });

  it('does not flag similarity just below the threshold (0.94)', () => {
    const result = classifyDegradedOutput(
      healthy({ similarityToPrior: 0.94 }),
    );
    expect(result.degraded).toBe(false);
  });

  it('does not flag emptiness ratio below the synthetic threshold (0.94)', () => {
    const result = classifyDegradedOutput(
      healthy({ contentLength: 100, emptinessRatio: 0.94 }),
    );
    expect(result.degraded).toBe(false);
  });

  it('does not flag a large, complex, multi-tool response', () => {
    const result = classifyDegradedOutput(
      healthy({ contentLength: 15_000, elapsedMs: 45_000 }),
    );
    expect(result.degraded).toBe(false);
  });

  it('does not flag a minimal but valid one-word reply quickly delivered', () => {
    // "OK" in 800 ms — real response, just short
    const result = classifyDegradedOutput(
      healthy({ contentLength: 2, elapsedMs: 800 }),
    );
    expect(result.degraded).toBe(false);
  });
});

describe('classifyDegradedOutput – cancelled', () => {
  it('returns cancelled when the process was cancelled', () => {
    const result = classifyDegradedOutput(
      healthy({ cancelled: true }),
    );
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('cancelled');
  });

  it('cancelled takes priority over duplicate-stale', () => {
    const result = classifyDegradedOutput(
      healthy({ cancelled: true, duplicateOfPrior: true }),
    );
    expect(result.reason).toBe('cancelled');
  });

  it('cancelled takes priority over stream-idle + zero content', () => {
    const result = classifyDegradedOutput(
      healthy({ cancelled: true, streamIdleFired: true, contentLength: 0 }),
    );
    expect(result.reason).toBe('cancelled');
  });

  it('cancelled takes priority over partial-replay similarity', () => {
    const result = classifyDegradedOutput(
      healthy({ cancelled: true, similarityToPrior: 0.99 }),
    );
    expect(result.reason).toBe('cancelled');
  });
});

describe('classifyDegradedOutput – duplicate-stale', () => {
  it('returns duplicate-stale when duplicateOfPrior is true', () => {
    const result = classifyDegradedOutput(
      healthy({ duplicateOfPrior: true }),
    );
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('duplicate-stale');
  });

  it('duplicate-stale takes priority over partial-replay similarity', () => {
    const result = classifyDegradedOutput(
      healthy({ duplicateOfPrior: true, similarityToPrior: 0.99 }),
    );
    expect(result.reason).toBe('duplicate-stale');
  });

  it('duplicate-stale takes priority over delayed signal', () => {
    const result = classifyDegradedOutput(
      healthy({ duplicateOfPrior: true, streamIdleFired: true, contentLength: 0 }),
    );
    expect(result.reason).toBe('duplicate-stale');
  });
});

describe('classifyDegradedOutput – partial-replay', () => {
  it('returns partial-replay at the similarity threshold (0.95)', () => {
    const result = classifyDegradedOutput(
      healthy({ similarityToPrior: 0.95 }),
    );
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('partial-replay');
  });

  it('returns partial-replay above threshold (0.99)', () => {
    const result = classifyDegradedOutput(
      healthy({ similarityToPrior: 0.99 }),
    );
    expect(result.reason).toBe('partial-replay');
  });

  it('partial-replay takes priority over delayed signal', () => {
    const result = classifyDegradedOutput(
      healthy({
        similarityToPrior: 0.97,
        streamIdleFired: true,
        contentLength: 10,
      }),
    );
    expect(result.reason).toBe('partial-replay');
  });
});

describe('classifyDegradedOutput – delayed', () => {
  it('returns delayed when stream-idle fired and content is below minimum', () => {
    const result = classifyDegradedOutput(
      healthy({ streamIdleFired: true, contentLength: 10 }),
    );
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('delayed');
  });

  it('returns delayed when stream-idle fired and content is exactly 0', () => {
    const result = classifyDegradedOutput(
      healthy({ streamIdleFired: true, contentLength: 0 }),
    );
    expect(result.reason).toBe('delayed');
  });

  it('returns delayed when elapsed >= 30 s and content < 50 chars (no idle watchdog)', () => {
    const result = classifyDegradedOutput(
      healthy({ elapsedMs: 30_000, contentLength: 20 }),
    );
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('delayed');
  });

  it('returns delayed for zero content after exactly 5 s elapsed', () => {
    const result = classifyDegradedOutput(
      healthy({ contentLength: 0, elapsedMs: 5_000 }),
    );
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('delayed');
  });

  it('does not flag zero content under the delay threshold (4 s)', () => {
    const result = classifyDegradedOutput(
      healthy({ contentLength: 0, elapsedMs: 4_000 }),
    );
    expect(result.degraded).toBe(false);
  });

  it('delayed (idle) takes priority over synthetic when idle also fires', () => {
    const result = classifyDegradedOutput(
      healthy({
        streamIdleFired: true,
        contentLength: 5,
        emptinessRatio: 0.98,
      }),
    );
    // idle-fired + low content → delayed wins before synthetic check
    expect(result.reason).toBe('delayed');
  });

  it('returns delayed at exactly the long-delay threshold with minimal content', () => {
    const result = classifyDegradedOutput(
      healthy({ elapsedMs: 30_000, contentLength: 49 }),
    );
    expect(result.reason).toBe('delayed');
  });

  it('does not flag long elapsed time when content is at the meaningful threshold', () => {
    // content = 50 chars (exactly MIN_MEANINGFUL_CHARS) — should NOT be delayed
    const result = classifyDegradedOutput(
      healthy({ elapsedMs: 30_000, contentLength: 50 }),
    );
    expect(result.degraded).toBe(false);
  });
});

describe('classifyDegradedOutput – synthetic', () => {
  it('returns synthetic when non-cancelled output is almost entirely whitespace', () => {
    const result = classifyDegradedOutput(
      healthy({
        contentLength: 200,
        emptinessRatio: 0.97,
        elapsedMs: 1_000,
      }),
    );
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('synthetic');
  });

  it('returns synthetic at the exact emptiness threshold (0.95)', () => {
    const result = classifyDegradedOutput(
      healthy({ contentLength: 100, emptinessRatio: 0.95, elapsedMs: 500 }),
    );
    expect(result.reason).toBe('synthetic');
  });

  it('does not flag synthetic when cancelled (cancelled wins)', () => {
    const result = classifyDegradedOutput(
      healthy({ cancelled: true, contentLength: 5, emptinessRatio: 0.99 }),
    );
    expect(result.reason).toBe('cancelled');
  });

  it('does not flag synthetic without an emptiness ratio (ratio not provided)', () => {
    const result = classifyDegradedOutput(
      healthy({ contentLength: 10, emptinessRatio: undefined, elapsedMs: 500 }),
    );
    expect(result.degraded).toBe(false);
  });

  it('does not flag synthetic when contentLength is 0 (ratio guard)', () => {
    // When contentLength is 0 the caller should not set emptinessRatio at all,
    // but if they do (a caller bug), the classifier must not mis-fire because
    // the contentLength > 0 guard in rule 7 protects us.
    const result = classifyDegradedOutput(
      healthy({ contentLength: 0, emptinessRatio: 0.99, elapsedMs: 100 }),
    );
    // contentLength === 0 means the synthetic rule won't fire (guard: contentLength > 0)
    expect(result.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tagResponseIfEnabled – flag-off path (CRITICAL: must be byte-identical to
// before A3 when flag is off — this is the whole point of default-off)
// ---------------------------------------------------------------------------

describe('tagResponseIfEnabled – flag OFF (default)', () => {
  it('leaves response.degradedReason undefined for a clearly degraded signal set', () => {
    const adapter = makeAdapter(false /* flag off */);
    const response: CliResponse = { id: '1', content: '', role: 'assistant' };

    // All of these would normally fire if flag were on
    adapter.callTagResponse(response, {
      contentLength: 0,
      elapsedMs: 60_000,
      streamIdleFired: true,
      cancelled: true,
      duplicateOfPrior: true,
    });

    expect(response.degradedReason).toBeUndefined();
  });

  it('leaves response.degradedReason undefined for a cancelled signal', () => {
    const adapter = makeAdapter(false);
    const response: CliResponse = { id: '1', content: '', role: 'assistant' };
    adapter.callTagResponse(response, {
      contentLength: 0,
      elapsedMs: 1_000,
      streamIdleFired: false,
      cancelled: true,
      duplicateOfPrior: false,
    });
    expect(response.degradedReason).toBeUndefined();
  });

  it('leaves response.degradedReason undefined for a duplicate-stale signal', () => {
    const adapter = makeAdapter(false);
    const response: CliResponse = { id: '1', content: 'hi', role: 'assistant' };
    adapter.callTagResponse(response, {
      contentLength: 2,
      elapsedMs: 500,
      streamIdleFired: false,
      cancelled: false,
      duplicateOfPrior: true,
    });
    expect(response.degradedReason).toBeUndefined();
  });

  it('does not mutate any other response field when flag is off', () => {
    const adapter = makeAdapter(false);
    const response: CliResponse = {
      id: 'resp-1',
      content: 'hello world',
      role: 'assistant',
      metadata: { foo: 'bar' },
    };
    const snapshot = JSON.stringify(response);

    adapter.callTagResponse(response, {
      contentLength: 11,
      elapsedMs: 500,
      streamIdleFired: false,
      cancelled: false,
      duplicateOfPrior: false,
    });

    expect(JSON.stringify(response)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// tagResponseIfEnabled – flag-on path
// ---------------------------------------------------------------------------

describe('tagResponseIfEnabled – flag ON', () => {
  it('tags response with cancelled when process was cancelled', () => {
    const adapter = makeAdapter(true);
    const response: CliResponse = { id: '1', content: '', role: 'assistant' };
    adapter.callTagResponse(response, {
      contentLength: 0,
      elapsedMs: 1_000,
      streamIdleFired: false,
      cancelled: true,
      duplicateOfPrior: false,
    });
    expect(response.degradedReason).toBe('cancelled');
  });

  it('tags response with duplicate-stale when duplicateOfPrior is true', () => {
    const adapter = makeAdapter(true);
    const response: CliResponse = { id: '1', content: 'old content', role: 'assistant' };
    adapter.callTagResponse(response, {
      contentLength: 11,
      elapsedMs: 500,
      streamIdleFired: false,
      cancelled: false,
      duplicateOfPrior: true,
    });
    expect(response.degradedReason).toBe('duplicate-stale');
  });

  it('tags response with partial-replay at 0.97 similarity', () => {
    const adapter = makeAdapter(true);
    const response: CliResponse = { id: '1', content: 'repeat', role: 'assistant' };
    adapter.callTagResponse(response, {
      contentLength: 6,
      elapsedMs: 1_000,
      streamIdleFired: false,
      cancelled: false,
      duplicateOfPrior: false,
      similarityToPrior: 0.97,
    });
    expect(response.degradedReason).toBe('partial-replay');
  });

  it('tags response with delayed when stream-idle fired and content is tiny', () => {
    const adapter = makeAdapter(true);
    const response: CliResponse = { id: '1', content: 'hi', role: 'assistant' };
    adapter.callTagResponse(response, {
      contentLength: 2,
      elapsedMs: 95_000,
      streamIdleFired: true,
      cancelled: false,
      duplicateOfPrior: false,
    });
    expect(response.degradedReason).toBe('delayed');
  });

  it('tags response with synthetic for high-emptiness whitespace-only output', () => {
    const adapter = makeAdapter(true);
    const response: CliResponse = { id: '1', content: '   \n\n   ', role: 'assistant' };
    adapter.callTagResponse(response, {
      contentLength: 8,
      elapsedMs: 500,
      streamIdleFired: false,
      cancelled: false,
      duplicateOfPrior: false,
      emptinessRatio: 0.96,
    });
    expect(response.degradedReason).toBe('synthetic');
  });

  it('leaves response untagged for healthy signals even when flag is on', () => {
    const adapter = makeAdapter(true);
    const response: CliResponse = {
      id: '1',
      content: 'A detailed and useful response with lots of content.',
      role: 'assistant',
    };
    adapter.callTagResponse(response, {
      contentLength: 52,
      elapsedMs: 4_000,
      streamIdleFired: false,
      cancelled: false,
      duplicateOfPrior: false,
      similarityToPrior: 0.3,
      emptinessRatio: 0.05,
    });
    expect(response.degradedReason).toBeUndefined();
  });

  it('is fail-soft: does not throw even if classifier throws internally', () => {
    const adapter = makeAdapter(true);
    const response: CliResponse = { id: '1', content: '', role: 'assistant' };

    // Pass a signals object where getter throws — simulating an unexpected error.
    // The classifyDegradedOutput function is pure and won't throw on valid input,
    // so we test the fail-soft wrapper by passing a Proxy that throws on access.
    const badSignals = new Proxy({} as DegradedOutputSignals, {
      get(_target, prop) {
        if (prop === 'cancelled') throw new Error('intentional test error');
        return undefined;
      },
    });

    // Must not throw
    expect(() => adapter.callTagResponse(response, badSignals)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Base-class tracking state tests
// ---------------------------------------------------------------------------

describe('BaseCliAdapter A3 tracking state', () => {
  it('exposes responseStartedAt and streamIdleDidFire protected fields', () => {
    const adapter = makeAdapter(false);
    // Before any process is spawned, defaults are 0/false
    expect(typeof adapter.testResponseStartedAt).toBe('number');
    expect(adapter.testStreamIdleDidFire).toBe(false);
  });
});
