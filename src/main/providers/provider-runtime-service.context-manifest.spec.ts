import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { withBrowserGatewaySystemPrompt } from '../cli/adapters/adapter-spawn-helpers';
import {
  _resetAllContextManifestsForTesting,
  buildContextManifestEntries,
  getLatestContextManifest,
  recordContextManifest,
} from '../context/context-manifest-store';
import { createSystemPromptComposer, SYSTEM_PROMPT_BLOCK_SEPARATOR } from '../context/prompt-injection-contract';
import { ProviderRuntimeRegistry } from './provider-runtime-registry';
import { ProviderRuntimeService } from './provider-runtime-service';

function seedManifest(instanceId: string): void {
  const composer = createSystemPromptComposer();
  composer.add('instructions', 'Base instructions');
  recordContextManifest(instanceId, 'spawn', buildContextManifestEntries(composer.compose().manifest));
}

describe('provider runtime context manifest', () => {
  beforeEach(() => _resetAllContextManifestsForTesting());

  it('records the exact adapter-appended browser guidance after direct adapter creation', () => {
    seedManifest('inst-browser');
    const options = {
      instanceId: 'inst-browser',
      systemPrompt: 'Base instructions',
      browserGatewayMcp: {
        aioMcpCliPath: '/example/aio-mcp',
        socketPath: '/example/browser.sock',
        instanceId: 'inst-browser',
        exists: () => true,
      },
    };
    const service = new ProviderRuntimeService({
      registry: new ProviderRuntimeRegistry(),
      createAdapter: vi.fn(() => ({ getRuntimeCapabilities: () => undefined } as unknown as CliAdapter)),
    });

    service.createAdapter({ cliType: 'codex', options });

    const appended = withBrowserGatewaySystemPrompt(options).systemPrompt!
      .split(SYSTEM_PROMPT_BLOCK_SEPARATOR)[1];
    const entry = getLatestContextManifest('inst-browser')?.entries
      .find((candidate) => candidate.kind === 'adapter-browser-gateway');
    expect(entry).toMatchObject({
      status: 'supplied',
      charLength: appended.length,
      contentHash: createHash('sha256').update(appended, 'utf8').digest('hex'),
      position: 1,
    });
  });

  it('records adapter guidance when a spawn-worker proxy is created', () => {
    seedManifest('inst-worker');
    const service = new ProviderRuntimeService({
      registry: new ProviderRuntimeRegistry(),
      createAdapter: vi.fn(() => ({ getRuntimeCapabilities: () => undefined } as unknown as CliAdapter)),
      settings: { get: vi.fn(() => true) as never },
    });

    const adapter = service.createAdapter({
      cliType: 'claude',
      options: {
        instanceId: 'inst-worker',
        systemPrompt: 'Base instructions',
        browserGatewayMcp: {
          aioMcpCliPath: '/example/aio-mcp',
          socketPath: '/example/browser.sock',
          instanceId: 'inst-worker',
          exists: () => true,
        },
      },
    });

    expect(adapter.getName()).toBe('claude-cli');
    expect(getLatestContextManifest('inst-worker')?.entries.find(
      (entry) => entry.kind === 'adapter-browser-gateway',
    )?.status).toBe('supplied');
  });

  it('keeps duplicate guidance absent and does not add duplicate manifest entries', () => {
    seedManifest('inst-dedupe');
    const options = {
      instanceId: 'inst-dedupe',
      systemPrompt: 'Base instructions\n\n[Browser Gateway]\nbrowser.find_or_open',
      browserGatewayMcp: {
        aioMcpCliPath: '/example/aio-mcp',
        socketPath: '/example/browser.sock',
        instanceId: 'inst-dedupe',
        exists: () => true,
      },
    };
    const service = new ProviderRuntimeService({
      registry: new ProviderRuntimeRegistry(),
      createAdapter: vi.fn(() => ({ getRuntimeCapabilities: () => undefined } as unknown as CliAdapter)),
    });

    service.createAdapter({ cliType: 'codex', options });
    service.createAdapter({ cliType: 'codex', options });

    const entries = getLatestContextManifest('inst-dedupe')?.entries.filter(
      (entry) => entry.kind === 'adapter-browser-gateway',
    );
    expect(entries).toEqual([{ kind: 'adapter-browser-gateway', status: 'skipped-empty' }]);
  });
});
