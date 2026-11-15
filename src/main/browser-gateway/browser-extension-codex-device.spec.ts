import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

interface Binding {
  operationHandle: string; approvalId: string; expectedIdentity: string;
  expiresAt: number; extensionInstanceId: string; extensionGeneration: string; documentId: string;
}
interface Frame { documentId: string; url: string; frameId?: number; tabId?: number }
interface Handoff {
  attest(tabId: number, binding: Binding): Promise<unknown>;
  fill(tabId: number, binding: Binding, documentId: string, code: string): Promise<unknown>;
  submit(tabId: number, binding: Binding, documentId: string): Promise<unknown>;
  cancel(tabId: number, binding: Binding): unknown;
  invalidateTab(tabId: number): void;
  invalidateAll(): void;
  navigation(kind: string, event: Frame): void;
}

const binding: Binding = {
  operationHandle: 'test-operation', approvalId: 'test-approval', expectedIdentity: 'approved@example.invalid',
  expiresAt: 50_000, extensionInstanceId: 'test-install', extensionGeneration: 'test-generation',
  documentId: 'test-consent-document',
};
const completion = { completed: true, observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin' };

function harness() {
  let now = 1_000;
  let enabled = true;
  let generation = 'test-generation';
  let frame: Frame = { documentId: binding.documentId, url: 'https://auth.openai.com/test-consent' };
  let handoff: Handoff;
  const deps = {
    now: () => now,
    runtime: () => ({ extensionInstanceId: 'test-install', extensionGeneration: generation }),
    enabled: () => enabled,
    // The browser adapter supplies these fixed route predicates, never command payloads.
    isConsent: (url: string) => url === 'https://auth.openai.com/test-consent',
    isDevice: (url: string) => url === 'https://auth.openai.com/test-device',
    getFrame: vi.fn(async () => ({ ...frame })),
    withBoundary: async (work: () => Promise<unknown>) => work(),
    taint: vi.fn(async () => undefined),
    consent: vi.fn(async () => ({ identity: binding.expectedIdentity })),
    transition: vi.fn(async () => {
      const event = { tabId: 42, frameId: 0, documentId: 'test-consent-document', url: 'https://auth.openai.com/test-device' };
      frame = event;
      handoff.navigation('history', event);
    }),
    fill: vi.fn(async () => true),
    submit: vi.fn(async () => true),
  };
  const source = readFileSync('resources/browser-extension/codex-device-handoff.js', 'utf8');
  const factory = runInNewContext(`${source}\ncreateCodexDeviceHandoff;`, { setTimeout, clearTimeout, URL }) as (input: typeof deps) => Handoff;
  handoff = factory(deps);
  return { handoff, deps, setFrame: (value: Frame) => { frame = value; },
    setNow: (value: number) => { now = value; }, setEnabled: () => { enabled = false; },
    restart: () => { generation = 'replacement-generation'; } };
}

describe('private Codex extension handoff ownership', () => {
  it('attests one document transition, verifies fill and consumes submit once', async () => {
    const h = harness();
    await expect(h.handoff.attest(42, binding)).resolves.toEqual({ completed: true, deviceDocumentId: 'test-consent-document' });
    await expect(h.handoff.fill(42, binding, 'test-consent-document', 'TESTCODEX')).resolves.toEqual(completion);
    await expect(h.handoff.submit(42, binding, 'test-consent-document')).resolves.toEqual(completion);
    await expect(h.handoff.submit(42, binding, 'test-consent-document')).rejects.toThrow('codex_device_handoff_refused');
    expect(h.deps.submit).toHaveBeenCalledTimes(1);
    h.setFrame({ documentId: binding.documentId, url: 'https://auth.openai.com/test-consent' });
    await expect(h.handoff.attest(42, binding)).rejects.toThrow('codex_device_handoff_refused');
  });

  it.each(['identity', 'origin', 'document', 'expiry', 'generation', 'protection'])('refuses wrong %s before consent transition', async (kind) => {
    const h = harness();
    if (kind === 'identity') h.deps.consent.mockResolvedValue({ identity: 'wrong@example.invalid' });
    if (kind === 'origin') h.setFrame({ documentId: binding.documentId, url: 'https://wrong.example.invalid/test-consent' });
    if (kind === 'document') h.setFrame({ documentId: 'wrong-document', url: 'https://auth.openai.com/test-consent' });
    if (kind === 'expiry') h.setNow(50_000);
    if (kind === 'generation') h.restart();
    if (kind === 'protection') h.setEnabled();
    await expect(h.handoff.attest(42, binding)).rejects.toThrow('codex_device_handoff_refused');
    expect(h.deps.transition).not.toHaveBeenCalled();
  });

  it.each(['history', 'before', 'reload', 'committed'])('invalidates unexpected %s after attestation', async (kind) => {
    const h = harness();
    await h.handoff.attest(42, binding);
    h.handoff.navigation(kind, { tabId: 42, frameId: 0, documentId: 'test-consent-document', url: 'https://auth.openai.com/test-device' });
    await expect(h.handoff.fill(42, binding, 'test-consent-document', 'TESTCODEX')).rejects.toThrow('codex_device_handoff_refused');
    expect(h.deps.fill).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'disconnect', 'watchdog', 'expiry', 'generation', 'document', 'approval', 'tab'])('never dispatches code after %s changes', async (kind) => {
    const h = harness();
    await h.handoff.attest(42, binding);
    if (kind === 'cancel') h.handoff.cancel(42, binding);
    if (kind === 'disconnect') h.handoff.invalidateAll();
    if (kind === 'watchdog') h.handoff.invalidateTab(42);
    if (kind === 'expiry') h.setNow(50_000);
    if (kind === 'generation') h.restart();
    if (kind === 'document') h.setFrame({ documentId: 'replacement-document', url: 'https://auth.openai.com/test-device' });
    await expect(h.handoff.fill(kind === 'tab' ? 43 : 42,
      kind === 'approval' ? { ...binding, approvalId: 'other-approval' } : binding,
      'test-consent-document', 'TESTCODEX')).rejects.toThrow('codex_device_handoff_refused');
    expect(h.deps.fill).not.toHaveBeenCalled();
  });

  it('does not convert a partial write or a secret-bearing exception into success', async () => {
    for (const throws of [false, true]) {
      const h = harness();
      await h.handoff.attest(42, binding);
      h.deps.fill.mockImplementation(async () => { if (throws) throw new Error('TESTCODEX'); return false; });
      await expect(h.handoff.fill(42, binding, 'test-consent-document', 'TESTCODEX')).rejects.toThrow(/^codex_device_handoff_refused$/);
      await expect(h.handoff.submit(42, binding, 'test-consent-document')).rejects.toThrow('codex_device_handoff_refused');
      expect(h.deps.submit).not.toHaveBeenCalled();
    }
  });

  it('checks cancellation again after asynchronous taint persistence, before private dispatch', async () => {
    const h = harness();
    await h.handoff.attest(42, binding);
    h.deps.taint.mockImplementation(async () => { h.handoff.invalidateTab(42); });
    await expect(h.handoff.fill(42, binding, 'test-consent-document', 'TESTCODEX')).rejects.toThrow('codex_device_handoff_refused');
    expect(h.deps.fill).not.toHaveBeenCalled();
  });

  it('invalidates a reentrant fill and never authorises a subsequent submit', async () => {
    const h = harness();
    await h.handoff.attest(42, binding);
    h.deps.fill.mockImplementation(async () => {
      await expect(h.handoff.fill(42, binding, 'test-consent-document', 'TESTCODEX')).rejects.toThrow('codex_device_handoff_refused');
      return true;
    });
    await expect(h.handoff.fill(42, binding, 'test-consent-document', 'TESTCODEX')).rejects.toThrow('codex_device_handoff_refused');
    await expect(h.handoff.submit(42, binding, 'test-consent-document')).rejects.toThrow('codex_device_handoff_refused');
  });
});
