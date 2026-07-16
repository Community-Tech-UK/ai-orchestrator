/**
 * A3: adapter-layer degraded-output tagging wiring.
 *
 * `degraded-output-classifier.spec.ts` covers the pure classifier in isolation.
 * This suite covers the *wiring* added in BaseCliAdapter — `completeResponse()`
 * and `tagResponseFromStreamState()` — which translate the adapter's own stream
 * state (elapsed time, idle watchdog, prior response) into the classifier's
 * signals and tag `CliResponse.degradedReason` in place, plus the bounded
 * trigram-similarity helper used for partial-replay detection.
 */

import { EventEmitter } from 'events';
import {
  BaseCliAdapter,
  computeBoundedTrigramSimilarity,
  type CliCapabilities,
  type CliMessage,
  type CliResponse,
  type CliStatus,
} from './base-cli-adapter';

/**
 * Minimal concrete adapter that does not spawn anything. The degraded-detection
 * flag is controlled directly (no SettingsManager), and the protected tagging
 * seams are exposed for the test. Stream-state fields (`responseStartedAt`,
 * `streamIdleDidFire`) are protected on the base class and set here to simulate
 * timing without real processes.
 */
class TestAdapter extends BaseCliAdapter {
  flagOn = false;

  constructor() {
    super({ command: 'test-cli' });
  }

  protected override isDegradedDetectionEnabled(): boolean {
    return this.flagOn;
  }

  // Expose protected seams + state to the test.
  public tag(response: CliResponse, opts?: { cancelled?: boolean }): void {
    this.tagResponseFromStreamState(response, opts);
  }
  public complete(response: CliResponse): void {
    this.completeResponse(response);
  }
  public setElapsed(ms: number): void {
    this.responseStartedAt = Date.now() - ms;
  }
  public fireStreamIdle(): void {
    this.streamIdleDidFire = true;
  }

  // ---- unused abstract contract ----
  getName(): string {
    return 'Test';
  }
  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: false,
      fileAccess: false,
      shellExecution: false,
      multiTurn: true,
      vision: false,
      codeExecution: false,
      contextWindow: 1000,
      outputFormats: ['text'],
    };
  }
  async checkStatus(): Promise<CliStatus> {
    return { available: true, version: '0', authenticated: true };
  }
  async sendMessage(_m: CliMessage): Promise<CliResponse> {
    return { id: 'x', content: '', role: 'assistant' };
  }
  // eslint-disable-next-line require-yield
  async *sendMessageStream(_m: CliMessage): AsyncIterable<string> {
    return;
  }
  parseOutput(raw: string): CliResponse {
    return { id: 'x', content: raw, role: 'assistant', raw };
  }
  protected buildArgs(_m: CliMessage): string[] {
    return [];
  }
  protected async sendInputImpl(_m: string): Promise<void> {
    /* no-op */
  }
}

function resp(content: string): CliResponse {
  return { id: 'r', content, role: 'assistant' };
}

describe('BaseCliAdapter A3 degraded tagging', () => {
  describe('tagResponseFromStreamState — flag off (default)', () => {
    it('is a no-op: never sets degradedReason even for clearly degraded output', () => {
      const a = new TestAdapter();
      a.flagOn = false;
      a.setElapsed(60_000);
      const r = resp(''); // empty + 60s elapsed = would be "delayed" if flag on
      a.tag(r);
      expect(r.degradedReason).toBeUndefined();
    });
  });

  describe('tagResponseFromStreamState — flag on', () => {
    it('tags "delayed" for empty content after a long elapsed time', () => {
      const a = new TestAdapter();
      a.flagOn = true;
      a.setElapsed(40_000);
      const r = resp('');
      a.tag(r);
      expect(r.degradedReason).toBe('delayed');
    });

    it('tags "delayed" when the stream-idle watchdog fired with near-empty content', () => {
      const a = new TestAdapter();
      a.flagOn = true;
      a.setElapsed(1_000);
      a.fireStreamIdle();
      const r = resp('ok'); // < MIN_MEANINGFUL_CHARS
      a.tag(r);
      expect(r.degradedReason).toBe('delayed');
    });

    it('tags "synthetic" for whitespace-dominated non-empty output', () => {
      const a = new TestAdapter();
      a.flagOn = true;
      a.setElapsed(500); // short, so delayed rules do not fire
      const r = resp('     \n\t   '); // all whitespace, length > 0
      a.tag(r);
      expect(r.degradedReason).toBe('synthetic');
    });

    it('tags "duplicate-stale" when content is identical to the prior turn', () => {
      const a = new TestAdapter();
      a.flagOn = true;
      a.setElapsed(500);
      const body = 'Here is a perfectly healthy, substantive answer to the question.';
      const first = resp(body);
      a.tag(first);
      expect(first.degradedReason).toBeUndefined(); // first turn, no prior
      const second = resp(body);
      a.tag(second);
      expect(second.degradedReason).toBe('duplicate-stale');
    });

    it('tags "partial-replay" when content is highly similar (not identical) to prior', () => {
      const a = new TestAdapter();
      a.flagOn = true;
      a.setElapsed(500);
      const base = 'The quick brown fox jumps over the lazy dog. '.repeat(40);
      const first = resp(base);
      a.tag(first);
      // Differ by a couple of characters near the end → >0.95 trigram similarity.
      const second = resp(base + 'X');
      a.tag(second);
      expect(second.degradedReason).toBe('partial-replay');
    });

    it('tags "cancelled" when the cancelled signal is passed, taking priority', () => {
      const a = new TestAdapter();
      a.flagOn = true;
      a.setElapsed(40_000); // would otherwise be "delayed"
      const r = resp('');
      a.tag(r, { cancelled: true });
      expect(r.degradedReason).toBe('cancelled');
    });

    it('does NOT tag a healthy, substantive, prompt response', () => {
      const a = new TestAdapter();
      a.flagOn = true;
      a.setElapsed(1_200);
      const r = resp('This is a thorough and well-formed answer with real content.');
      a.tag(r);
      expect(r.degradedReason).toBeUndefined();
    });
  });

  describe('completeResponse', () => {
    it('emits "complete" with the tagged response (consumer sees degradedReason)', () => {
      const a = new TestAdapter();
      a.flagOn = true;
      a.setElapsed(40_000);
      const received: CliResponse[] = [];
      a.on('complete', (r: CliResponse) => received.push(r));
      const r = resp('');
      a.complete(r);
      expect(received).toHaveLength(1);
      expect(received[0]).toBe(r);
      expect(received[0].degradedReason).toBe('delayed');
    });

    it('re-arms the per-turn stream-idle flag after each completion (persistent-session adapters)', () => {
      const a = new TestAdapter();
      a.flagOn = true;
      // Turn 1: the idle watchdog fired, but the turn still produced a long,
      // healthy answer — not tagged. Completion must re-arm the flag.
      a.setElapsed(1_000);
      a.fireStreamIdle();
      const t1 = resp('A long, healthy, substantive answer that is well over the threshold.');
      a.complete(t1);
      expect(t1.degradedReason).toBeUndefined();

      // Turn 2: short output, no fresh idle — must NOT inherit turn 1's idle flag.
      a.setElapsed(800);
      const t2 = resp('Done.');
      a.complete(t2);
      expect(t2.degradedReason).toBeUndefined();
    });

    it('emits "complete" unchanged when the flag is off', () => {
      const a = new TestAdapter();
      a.flagOn = false;
      const events = new EventEmitter();
      let seen: CliResponse | undefined;
      a.on('complete', (r: CliResponse) => {
        seen = r;
        events.emit('done');
      });
      const r = resp('');
      a.complete(r);
      expect(seen).toBe(r);
      expect(seen?.degradedReason).toBeUndefined();
    });
  });
});

describe('computeBoundedTrigramSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(computeBoundedTrigramSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns a high value (>0.95) for near-identical long strings', () => {
    const base = 'lorem ipsum dolor sit amet '.repeat(60);
    expect(computeBoundedTrigramSimilarity(base, base + 'z')).toBeGreaterThan(0.95);
  });

  it('returns a low value for unrelated strings', () => {
    const sim = computeBoundedTrigramSimilarity(
      'aaaaaaaaaaaaaaaaaaaa',
      'zzzzzzzzzzzzzzzzzzzz',
    );
    expect(sim).toBeLessThan(0.1);
  });

  it('returns 0 for distinct strings too short to form trigrams', () => {
    expect(computeBoundedTrigramSimilarity('ab', 'cd')).toBe(0);
  });

  it('stays bounded and finite for very large inputs', () => {
    const big = 'x'.repeat(500_000);
    const big2 = 'x'.repeat(500_000) + 'tail';
    const sim = computeBoundedTrigramSimilarity(big, big2);
    expect(sim).toBeGreaterThanOrEqual(0);
    expect(sim).toBeLessThanOrEqual(1);
  });
});
