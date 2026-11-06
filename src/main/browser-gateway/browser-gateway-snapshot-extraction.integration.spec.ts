import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const aux = vi.hoisted(() => ({ enabled: true, generate: vi.fn() }));
vi.mock('./browser-aux-extraction', async (importOriginal) => {
  const real = await importOriginal<typeof import('./browser-aux-extraction')>();
  return { ...real, maybeExtractPageText: (text: string, hint: string | undefined) =>
    real.maybeExtractPageText(text, hint, { isEnabled: () => aux.enabled, generate: aux.generate }) };
});

import { BrowserGatewayService } from './browser-gateway-service';
import { stopBrowserCampaignRuntime } from './browser-campaign-runtime';
import { makeProfile, makeService } from './browser-gateway-service.test-helpers';
import { WorkerNodeRegistry } from '../remote-node/worker-node-registry';
import { _setToolOutputDirForTesting } from '../util/tool-output-truncation';

const marker = '\n\n[Output truncated.';
const page = `${'navigation '.repeat(3_000)}\nThe annual price is £240.\npassword=PLACEHOLDER_BROWSER_VALUE\n${'footer '.repeat(5_000)}`;
const request = { profileId: 'profile-1', targetId: 'target-1', instanceId: 'instance-1', provider: 'claude' };

describe('snapshot extraction before the agent preview cap', () => {
  let outputs: string;

  beforeEach(() => {
    outputs = mkdtempSync(join(tmpdir(), 'aio-snapshot-extraction-'));
    _setToolOutputDirForTesting(outputs);
    aux.enabled = true;
    aux.generate.mockReset().mockResolvedValue({ text: 'The annual price is £240.', source: 'primary' });
  });

  afterEach(() => {
    _setToolOutputDirForTesting(null);
    rmSync(outputs, { recursive: true, force: true });
    BrowserGatewayService._resetForTesting();
    stopBrowserCampaignRuntime();
    WorkerNodeRegistry._resetForTesting();
  });

  function serviceFor(path: 'managed' | 'live' | 'cached') {
    if (path === 'managed') return makeService({ snapshot: async () => ({ title: 'Pricing', url: 'http://localhost:4567', text: page }) }).service;
    return makeService({
      existingTab: { ...request, tabId: 42, windowId: 7, title: 'Pricing', url: 'http://localhost:4567',
        origin: 'http://localhost:4567', allowedOrigins: makeProfile().allowedOrigins, text: path === 'cached' ? page : 'old page' },
      extensionCommandStore: { sendCommand: vi.fn(async () => {
        if (path === 'cached') throw new Error('browser_extension_command_timeout');
        return { tabId: 42, windowId: 7, title: 'Pricing', url: 'http://localhost:4567', text: page };
      }) },
    }).service;
  }

  it.each(['managed', 'live', 'cached'] as const)('extracts relevant text beyond 12 KB on the %s path with one redacted raw spill', async (path) => {
    const result = await serviceFor(path).snapshot({ ...request, extractionHint: 'Find the annual price' });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(aux.generate).toHaveBeenCalledTimes(1);
    const prompt = aux.generate.mock.calls[0][1] as string;
    expect(prompt).toContain('The annual price is £240.');
    expect(prompt).toContain('password=[REDACTED]');
    expect(prompt).not.toContain('PLACEHOLDER_BROWSER_VALUE');
    expect(prompt).not.toContain('Output truncated.');
    expect(prompt.length).toBeLessThan(52_000);
    expect(result.data?.text?.split(marker)[0]).toBe('The annual price is £240.');
    const files = readdirSync(outputs);
    expect(files).toHaveLength(1);
    const saved = readFileSync(join(outputs, files[0]), 'utf8');
    expect(saved).toContain('The annual price is £240.');
    expect(saved).toContain('password=[REDACTED]');
    expect(saved).not.toContain('PLACEHOLDER_BROWSER_VALUE');
    expect(result.data?.text).toContain(join(outputs, files[0]));
  });

  it('still bounds the extraction input independently from the full recoverable page', async () => {
    const text = `${'n'.repeat(60_000)}\nBEYOND_EXTRACTION_BUDGET`;
    const { service } = makeService({ snapshot: async () => ({ title: 'Long page', url: 'http://localhost:4567', text }) });
    await service.snapshot({ ...request, extractionHint: 'Find a price' });
    expect(aux.generate.mock.calls[0][1]).not.toContain('BEYOND_EXTRACTION_BUDGET');
    expect((aux.generate.mock.calls[0][1] as string).length).toBeLessThan(52_000);
    expect(readFileSync(join(outputs, readdirSync(outputs)[0]), 'utf8')).toContain('BEYOND_EXTRACTION_BUDGET');
  });

  it.each(['off', 'failure', 'fallback', 'oversized', 'too-many-lines'] as const)('keeps a bounded preview and one full raw spill when extraction is %s', async (mode) => {
    aux.enabled = mode !== 'off';
    if (mode === 'failure') aux.generate.mockRejectedValue(new Error('test extraction failure'));
    if (mode === 'fallback') aux.generate.mockResolvedValue({ text: 'No extraction', source: 'fallback' });
    if (mode === 'oversized') aux.generate.mockResolvedValue({ text: 'e'.repeat(20_000), source: 'primary' });
    if (mode === 'too-many-lines') aux.generate.mockResolvedValue({ text: 'e\n'.repeat(401), source: 'primary' });

    const result = await serviceFor('managed').snapshot({ ...request, extractionHint: 'Find the annual price' });

    expect(Buffer.byteLength(result.data?.text?.split(marker)[0] ?? '')).toBeLessThanOrEqual(12_000);
    expect(readdirSync(outputs)).toHaveLength(1);
    if (mode === 'off') expect(aux.generate).not.toHaveBeenCalled();
  });
});
