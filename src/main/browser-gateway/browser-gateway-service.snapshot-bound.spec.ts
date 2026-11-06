/**
 * Plan 9d: a page read through Harness's own (managed) browser comes back cut to
 * the same 12,000-byte / 400-line preview as a logged-in tab, with the full
 * redacted text saved to a file. The driver now hands the gateway up to 1 MB
 * (puppeteer-browser-driver.ts), so this bound is the only thing between a
 * large page and the agent's context. Suffix R6N6.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserGatewayService } from './browser-gateway-service';
import { stopBrowserCampaignRuntime } from './browser-campaign-runtime';
import { makeService } from './browser-gateway-service.test-helpers';
import { WorkerNodeRegistry } from '../remote-node/worker-node-registry';
import { _setToolOutputDirForTesting } from '../util/tool-output-truncation';

const request = {
  profileId: 'profile-1',
  targetId: 'target-1',
  instanceId: 'instance-1',
  provider: 'claude',
} as const;

const HINT_START = '\n\n[Output truncated. The full output (';

describe('BrowserGatewayService managed snapshot bound (R6N6)', () => {
  let outputs: string;

  beforeEach(() => {
    outputs = mkdtempSync(join(tmpdir(), 'aio-managed-snapshot-'));
    _setToolOutputDirForTesting(outputs);
  });

  afterEach(() => {
    _setToolOutputDirForTesting(null);
    rmSync(outputs, { recursive: true, force: true });
    BrowserGatewayService._resetForTesting();
    stopBrowserCampaignRuntime();
    WorkerNodeRegistry._resetForTesting();
  });

  it('bounds a 1 MB multi-line managed page to 12,000 bytes / 400 lines plus the saved-file marker', async () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `row ${String(i).padStart(5, '0')} ${'x'.repeat(40)}`);
    lines[3] = 'password=PLACEHOLDER_BROWSER_VALUE';
    const page = lines.join('\n');
    expect(page.length).toBeGreaterThan(1_000_000);
    const { service, driver } = makeService({
      snapshot: async () => ({ title: 'Big page', url: 'http://localhost:4567', text: page }),
    });

    const result = await service.snapshot(request);

    expect(driver.snapshot).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    const text = result.data?.text ?? '';
    const markerAt = text.indexOf(HINT_START);
    expect(markerAt).toBeGreaterThan(0);
    const preview = text.slice(0, markerAt);
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(12_000);
    expect(preview.split('\n').length).toBeLessThanOrEqual(400);
    expect(preview).toContain('row 00000');
    expect(preview).not.toContain('row 19999');
    expect(preview).toContain('password=[REDACTED]');
    expect(text.length).toBeLessThan(13_000);

    const [file] = readdirSync(outputs);
    expect(readdirSync(outputs)).toHaveLength(1);
    expect(text).toContain(`is saved at ${join(outputs, file)}.`);
    const saved = readFileSync(join(outputs, file), 'utf8');
    expect(saved).toContain('row 19999');
    expect(saved).toContain('password=[REDACTED]');
    expect(saved).not.toContain('PLACEHOLDER_BROWSER_VALUE');
  });

  it('bounds a 1 MB single-line managed page the same way', async () => {
    const page = 'y'.repeat(1_000_000);
    const { service } = makeService({
      snapshot: async () => ({ title: 'One long line', url: 'http://localhost:4567', text: page }),
    });

    const text = (await service.snapshot(request)).data?.text ?? '';

    const preview = text.slice(0, text.indexOf(HINT_START));
    expect(Buffer.byteLength(preview)).toBe(12_000);
    expect(text).toContain('Read that file in sections if you need more.]');
    expect(readFileSync(join(outputs, readdirSync(outputs)[0]), 'utf8')).toHaveLength(1_000_000);
  });

  it('leaves a small managed page unchanged and saves nothing', async () => {
    const { service } = makeService();

    const result = await service.snapshot(request);

    expect(result.data?.text).toBe('hello');
    expect(readdirSync(outputs)).toHaveLength(0);
  });
});
