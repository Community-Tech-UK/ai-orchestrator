import { afterEach, describe, expect, it } from 'vitest';

import {
  clearKnownModelCatalogSnapshotForTesting,
  replaceKnownModelCatalogSnapshot,
} from '../../../shared/types/provider-model-catalog-snapshot';
import { AntigravityCliAdapter } from './antigravity-cli-adapter';
import type { CliMessage } from './base-cli-adapter';

/** Expose the protected buildArgs for assertion. */
interface BuildArgsAccess {
  buildArgs(message: CliMessage): string[];
}

function buildArgs(adapter: AntigravityCliAdapter, content = 'hello'): string[] {
  return (adapter as unknown as BuildArgsAccess).buildArgs({ role: 'user', content });
}

function forwardedModel(adapter: AntigravityCliAdapter): string | undefined {
  const args = buildArgs(adapter);
  const modelIdx = args.indexOf('--model');
  return modelIdx >= 0 ? args[modelIdx + 1] : undefined;
}

describe('AntigravityCliAdapter buildArgs model forwarding', () => {
  afterEach(() => {
    clearKnownModelCatalogSnapshotForTesting();
  });

  it('forwards a known agy label as --model <label>', () => {
    const adapter = new AntigravityCliAdapter({ model: 'Gemini 4 Argon (High)' });
    expect(forwardedModel(adapter)).toBe('Gemini 4 Argon (High)');
  });

  it('moves a retired label from a saved session to its successor', () => {
    // agy 1.4 exits 1 on "Gemini 3.5 Flash (Medium)"; wake/restart rebuild the
    // config from the persisted model, so the spawn boundary must repair it.
    const adapter = new AntigravityCliAdapter({ model: 'Gemini 3.5 Flash (Medium)' });
    expect(forwardedModel(adapter)).toBe('Gemini 3.8 Flash (Medium)');
  });

  it('keeps a replaced label while it is still on the known list', () => {
    replaceKnownModelCatalogSnapshot([
      { provider: 'antigravity', id: 'Gemini 3.5 Flash (Medium)' },
    ]);

    expect(forwardedModel(new AntigravityCliAdapter({ model: 'Gemini 3.5 Flash (Medium)' })))
      .toBe('Gemini 3.5 Flash (Medium)');
  });

  it('forwards a label only the live agy list has, and drops one it no longer lists', () => {
    replaceKnownModelCatalogSnapshot([
      { provider: 'antigravity', id: 'Gemini 5 Boron (Medium)', pinned: true },
    ]);

    expect(forwardedModel(new AntigravityCliAdapter({ model: 'Gemini 5 Boron (Medium)' })))
      .toBe('Gemini 5 Boron (Medium)');
    expect(buildArgs(new AntigravityCliAdapter({ model: 'Gemini 4 Argon (High)' })))
      .not.toContain('--model');
  });

  it('omits --model for a stale cross-provider id so agy uses its default', () => {
    const adapter = new AntigravityCliAdapter({ model: 'gemini-3-pro-preview' });
    expect(buildArgs(adapter)).not.toContain('--model');
  });

  it('omits --model when no model is configured', () => {
    const adapter = new AntigravityCliAdapter({});
    expect(buildArgs(adapter)).not.toContain('--model');
  });

  it('always ends with --print and the prompt as the final arg', () => {
    const adapter = new AntigravityCliAdapter({ model: 'GPT-OSS 120B (Medium)' });
    const args = buildArgs(adapter, 'do the thing');
    expect(args[args.length - 2]).toBe('--print');
    expect(args[args.length - 1]).toBe('do the thing');
  });

  it('T48: wraps every print prompt with RTK while resume stays unavailable', () => {
    const adapter = new AntigravityCliAdapter({ rtkEnabled: true });
    expect(adapter.getRuntimeCapabilities().supportsResume).toBe(false);
    const first = buildArgs(adapter, 'turn one');
    const second = buildArgs(adapter, 'turn two');
    expect(first[first.length - 1]).toContain('[RTK AWARENESS]');
    expect(second[second.length - 1]).toContain('[RTK AWARENESS]');
  });

  it('adds --dangerously-skip-permissions when yolo is enabled', () => {
    const adapter = new AntigravityCliAdapter({ yolo: true });
    expect(buildArgs(adapter)).toContain('--dangerously-skip-permissions');
  });

  it('LT-146: scopes agy to the configured working directory via --add-dir', () => {
    const adapter = new AntigravityCliAdapter({ workingDir: '/tmp/aio-lt-evidence-batchC' });
    const args = buildArgs(adapter);
    const addDirIdx = args.indexOf('--add-dir');
    expect(addDirIdx).toBeGreaterThanOrEqual(0);
    expect(args[addDirIdx + 1]).toBe('/tmp/aio-lt-evidence-batchC');
  });

  it('LT-146: omits --add-dir when no working directory is configured', () => {
    const adapter = new AntigravityCliAdapter({});
    expect(buildArgs(adapter)).not.toContain('--add-dir');
  });
});
