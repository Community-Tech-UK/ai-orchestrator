/**
 * Cross-provider parity matrix — Task 24, Wave 2 Provider Normalization.
 *
 * Proves that semantically-equivalent adapter events produce
 * structurally-equivalent envelopes across all four providers by driving
 * each provider at the adapter-event boundary (the same seam used by the
 * four per-provider specs).
 *
 * Matrix: 5 scenarios × 4 providers = 20 test cases.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ProviderRuntimeEventEnvelope, ProviderName } from '@contracts/types/provider-runtime-events';
import type { BaseProvider } from '../../provider-interface';

// ---------------------------------------------------------------------------
// FakeAdapter implementations — one per adapter module.
// Each is tailored to the stubs its provider calls inside initialize().
// ---------------------------------------------------------------------------

// --- Claude ---
class FakeClaudeAdapter extends EventEmitter {
  async spawn(): Promise<void> { /* no-op */ }
  getSessionId(): string { return 'sess-claude'; }
  getPid(): number | null { return 4321; }
  async terminate(): Promise<void> { /* no-op */ }
  async sendInput(): Promise<void> { /* no-op */ }
}

vi.mock('../../../cli/adapters/claude-cli-adapter', () => ({
  ClaudeCliAdapter: vi.fn().mockImplementation(() => new FakeClaudeAdapter()),
}));

// --- Codex ---
class FakeCodexAdapter extends EventEmitter {
  async initialize(): Promise<void> { /* no-op */ }
  getSessionId(): string { return 'sess-codex'; }
  getPid(): number | null { return 1234; }
  async terminate(): Promise<void> { /* no-op */ }
  async sendMessage(): Promise<{ id: string; content: string; role: string }> {
    return { id: 'r1', content: 'reply', role: 'assistant' };
  }
}

vi.mock('../../../cli/adapters/codex-cli-adapter', () => ({
  CodexCliAdapter: vi.fn().mockImplementation(() => new FakeCodexAdapter()),
}));

// --- Gemini ---
class FakeGeminiAdapter extends EventEmitter {
  async initialize(): Promise<void> { /* no-op */ }
  getSessionId(): string { return 'sess-gemini'; }
  getPid(): number | null { return 5678; }
  async terminate(): Promise<void> { /* no-op */ }
  async sendMessage(): Promise<{ id: string; content: string; role: string }> {
    return { id: 'r2', content: 'reply', role: 'assistant' };
  }
}

vi.mock('../../../cli/adapters/gemini-cli-adapter', () => ({
  GeminiCliAdapter: vi.fn().mockImplementation(() => new FakeGeminiAdapter()),
}));

// --- Copilot ---
class FakeCopilotAdapter extends EventEmitter {
  async spawn(): Promise<void> { /* no-op */ }
  getSessionId(): string { return 'sess-copilot'; }
  getPid(): number | null { return null; }
  async terminate(): Promise<void> { /* no-op */ }
  async sendInput(): Promise<void> { /* no-op */ }
  async checkStatus(): Promise<{ available: boolean }> { return { available: true }; }
}

vi.mock('../../../cli/adapters/copilot-cli-adapter', () => ({
  CopilotCliAdapter: vi.fn().mockImplementation(() => new FakeCopilotAdapter()),
}));

// ---------------------------------------------------------------------------
// Provider imports — after vi.mock hoisting resolves the factories above.
// ---------------------------------------------------------------------------
import { ClaudeCliProvider } from '../../claude-cli-provider';
import { CodexCliProvider } from '../../codex-cli-provider';
import { GeminiCliProvider } from '../../gemini-cli-provider';
import { CopilotCliProvider } from '../../copilot-cli-provider';

// ---------------------------------------------------------------------------
// Fixture type: constructs a provider+adapter pair with instanceId 'i-parity'.
// ---------------------------------------------------------------------------
interface ParityFixture {
  setup: () => Promise<{ provider: BaseProvider; adapter: EventEmitter; envelopes: ProviderRuntimeEventEnvelope[] }>;
}

const PROVIDERS: Record<ProviderName, ParityFixture> = {
  claude: {
    setup: async () => {
      const provider = new ClaudeCliProvider({ type: 'claude-cli', name: 'test', enabled: true });
      const envelopes: ProviderRuntimeEventEnvelope[] = [];
      provider.events$.subscribe(e => envelopes.push(e));
      await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-parity' });
      const adapter = (provider as unknown as { adapter: EventEmitter }).adapter;
      return { provider, adapter, envelopes };
    },
  },
  codex: {
    setup: async () => {
      const provider = new CodexCliProvider({ type: 'openai', name: 'test', enabled: true });
      const envelopes: ProviderRuntimeEventEnvelope[] = [];
      provider.events$.subscribe(e => envelopes.push(e));
      await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-parity' });
      const adapter = (provider as unknown as { adapter: EventEmitter }).adapter;
      return { provider, adapter, envelopes };
    },
  },
  gemini: {
    setup: async () => {
      const provider = new GeminiCliProvider({ type: 'google', name: 'test', enabled: true });
      const envelopes: ProviderRuntimeEventEnvelope[] = [];
      provider.events$.subscribe(e => envelopes.push(e));
      await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-parity' });
      const adapter = (provider as unknown as { adapter: EventEmitter }).adapter;
      return { provider, adapter, envelopes };
    },
  },
  copilot: {
    setup: async () => {
      const provider = new CopilotCliProvider({ type: 'copilot', name: 'GitHub Copilot CLI', enabled: true });
      const envelopes: ProviderRuntimeEventEnvelope[] = [];
      provider.events$.subscribe(e => envelopes.push(e));
      await provider.initialize({ workingDirectory: '/tmp', instanceId: 'i-parity' });
      const adapter = (provider as unknown as { adapter: EventEmitter }).adapter;
      return { provider, adapter, envelopes };
    },
  },
};

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------
interface Scenario {
  /** Human-readable label for the describe block. */
  name: string;
  /** Emit this on the fake adapter to trigger the translation path. */
  fire: (adapter: EventEmitter) => void;
  /** Partial event shape that must match across all four providers. */
  expectedEvent: Record<string, unknown>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'output',
    fire: (a) =>
      a.emit('output', {
        id: 'm',
        type: 'assistant',
        content: 'hi',
        timestamp: Date.now(),
        metadata: { foo: 1 },
      }),
    expectedEvent: { kind: 'output', content: 'hi', messageType: 'assistant', metadata: { foo: 1 } },
  },
  {
    name: 'status',
    fire: (a) => a.emit('status', 'busy'),
    expectedEvent: { kind: 'status', status: 'busy' },
  },
  {
    name: 'error',
    fire: (a) => a.emit('error', new Error('boom')),
    expectedEvent: { kind: 'error', message: 'boom', recoverable: false },
  },
  {
    name: 'exit',
    fire: (a) => a.emit('exit', 0, null),
    expectedEvent: { kind: 'exit', code: 0, signal: null },
  },
  {
    name: 'spawned',
    fire: (a) => a.emit('spawned', 1234),
    expectedEvent: { kind: 'spawned', pid: 1234 },
  },
];

// ---------------------------------------------------------------------------
// Matrix: 5 scenarios × 4 providers = 20 test cases
// ---------------------------------------------------------------------------
describe('cross-provider parity', () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      for (const [providerName, fixture] of Object.entries(PROVIDERS) as [ProviderName, ParityFixture][]) {
        it(`${providerName} produces a matching envelope`, async () => {
          const { adapter, envelopes } = await fixture.setup();

          // Clear any envelopes emitted during initialize (e.g. spawned from
          // CodexCliProvider / GeminiCliProvider setting isActive = true).
          envelopes.length = 0;

          scenario.fire(adapter);

          const last = envelopes.at(-1);
          expect(last).toBeDefined();
          expect(last!.provider).toBe(providerName);
          expect(last!.instanceId).toBe('i-parity');
          expect(last!.event).toMatchObject(scenario.expectedEvent);
        });
      }
    });
  }
});
