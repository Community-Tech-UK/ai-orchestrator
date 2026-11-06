import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configContentWithoutModelLimits,
  limitsFromModelMetadata,
  readOpenCodeNativeModelLimits,
  _resetOpenCodeNativeModelLimitsForTesting,
} from './opencode-native-model-limits';
import type { OpenCodeModelMetadataBlock } from './opencode-account-provider-config';

const mocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('./opencode-effective-budget-config', () => ({ runOpenCodeCapture: mocks.capture }));

const block = (providerId: string, modelId: string, limit: unknown): OpenCodeModelMetadataBlock =>
  ({ providerId, modelId, metadata: { limit } });

describe('OpenCode native model catalog limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOpenCodeNativeModelLimitsForTesting();
  });
  afterEach(() => vi.restoreAllMocks());

  it('reads positive context and output limits for the named model', () => {
    expect(limitsFromModelMetadata([
      block('openai', 'other', { context: 1, output: 2 }),
      block('openai', 'gpt-4o', { context: 128_000, output: 16_384 }),
    ], 'openai/gpt-4o')).toEqual({ context: 128_000, output: 16_384 });
  });

  it('treats non-positive catalog limits as unknown and keeps the other field', () => {
    expect(limitsFromModelMetadata([block('openai', 'image', { context: 0, input: 0, output: 0 })], 'openai/image'))
      .toEqual({ context: undefined, output: undefined });
    expect(limitsFromModelMetadata([block('p', 'm', { context: 0, output: 700 })], 'p/m'))
      .toEqual({ context: undefined, output: 700 });
  });

  it('returns undefined when the catalog does not list the model or the id is malformed', () => {
    expect(limitsFromModelMetadata([block('openai', 'gpt-4o', { context: 1, output: 2 })], 'openai/absent')).toBeUndefined();
    expect(limitsFromModelMetadata([], 'openai/gpt-4o')).toBeUndefined();
    expect(limitsFromModelMetadata([block('p', 'a/b', { context: 1, output: 2 })], 'p/a/b'))
      .toEqual({ context: 1, output: 2 });
    expect(limitsFromModelMetadata([], 'noprovider')).toBeUndefined();
    expect(limitsFromModelMetadata([], '')).toBeUndefined();
  });

  it('lists the model provider verbosely on version 1 and caches the resolution', async () => {
    mocks.capture.mockResolvedValue({ code: 0, stdout: 'openai/gpt-4o\n{"id":"gpt-4o","providerID":"openai","limit":{"context":128000,"output":16384}}\n' });
    const read = () => readOpenCodeNativeModelLimits({
      command: 'opencode', cliMajor: 1, workingDirectory: '/tmp', env: {}, model: 'openai/gpt-4o',
    });
    await expect(read()).resolves.toEqual({ context: 128_000, output: 16_384 });
    await expect(read()).resolves.toEqual({ context: 128_000, output: 16_384 });
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture.mock.calls[0]?.[0]).toMatchObject({
      command: 'opencode',
      args: ['models', 'openai', '--verbose'],
      workingDirectory: '/tmp',
    });
  });

  it('reads the standalone model endpoint on version 2', async () => {
    mocks.capture.mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: [
      { providerID: 'openai', modelID: 'gpt-4o', enabled: true, capabilities: { tools: true }, limit: { context: 128000, output: 16384 } },
    ] }) });
    await expect(readOpenCodeNativeModelLimits({
      command: '/bin/opencode', cliMajor: 2, workingDirectory: '/tmp', env: {}, model: 'openai/gpt-4o',
    })).resolves.toEqual({ context: 128_000, output: 16_384 });
    expect(mocks.capture.mock.calls[0]?.[0]).toMatchObject({
      command: '/bin/opencode',
      args: ['api', '--standalone', 'GET', '/api/model'],
    });
  });

  it('is fail-soft on a failed read and retries the next spawn, without caching misses', async () => {
    const read = () => readOpenCodeNativeModelLimits({
      command: 'opencode', cliMajor: 1, workingDirectory: '/tmp', env: {}, model: 'openai/gpt-4o',
    });
    mocks.capture.mockResolvedValueOnce({ code: 1, stdout: '' });
    await expect(read()).resolves.toBeUndefined();
    mocks.capture.mockRejectedValueOnce(new Error('Native configuration probe failed'));
    await expect(read()).resolves.toBeUndefined();
    mocks.capture.mockResolvedValueOnce({ code: 0, stdout: 'openai/gpt-4o\n{"id":"gpt-4o","providerID":"openai","limit":{"context":128000,"output":16384}}\n' });
    await expect(read()).resolves.toEqual({ context: 128_000, output: 16_384 });
    expect(mocks.capture).toHaveBeenCalledTimes(3);
  });

  it('caches a model listed without usable limits and rejects malformed ids before any read', async () => {
    mocks.capture.mockResolvedValue({ code: 0, stdout: 'openai/image\n{"id":"image","providerID":"openai","limit":{"context":0,"output":0}}\n' });
    const read = () => readOpenCodeNativeModelLimits({
      command: 'opencode', cliMajor: 1, workingDirectory: '/tmp', env: {}, model: 'openai/image',
    });
    await expect(read()).resolves.toEqual({ context: undefined, output: undefined });
    await expect(read()).resolves.toEqual({ context: undefined, output: undefined });
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    await expect(readOpenCodeNativeModelLimits({
      command: 'opencode', cliMajor: 1, workingDirectory: '/tmp', env: {}, model: 'noprovider',
    })).resolves.toBeUndefined();
    expect(mocks.capture).toHaveBeenCalledTimes(1);
  });

  it('drops model limit overrides from the overlay in both config shapes and keeps everything else', () => {
    const strip = (content: unknown) => JSON.parse(configContentWithoutModelLimits(JSON.stringify(content))!);
    expect(strip({ provider: { openai: { models: { 'gpt-4o': { limit: { context: 250_000, output: 16_384 }, options: { max_completion_tokens: 9 } } } } } }))
      .toEqual({ provider: { openai: { models: { 'gpt-4o': { options: { max_completion_tokens: 9 } } } } } });
    expect(strip({ providers: { p: { models: { m: { limit: { output: 1 }, body: { x: 1 } }, n: {} }, options: { y: 2 } } }, agent: { build: { limit: { context: 3 } } } }))
      .toEqual({ providers: { p: { models: { m: { body: { x: 1 } }, n: {} }, options: { y: 2 } } }, agent: { build: { limit: { context: 3 } } } });
    expect(configContentWithoutModelLimits(undefined)).toBeUndefined();
    expect(configContentWithoutModelLimits('not json')).toBe('not json');
    expect(configContentWithoutModelLimits('[1,2]')).toBe('[1,2]');
    expect(configContentWithoutModelLimits('{"provider":{"openai":{"models":"broken"}}}'))
      .toBe('{"provider":{"openai":{"models":"broken"}}}');
  });

  it('reads the catalog without the session overlay so a ceiling can never be cached as native', async () => {
    // The CLI merges OPENCODE_CONFIG_CONTENT model limits into `models
    // --verbose`, so a session whose overlay carries a ceiling would report the
    // ceiling as the model window (verifier round 4, reproduced on OpenCode
    // 1.19.4). The read must ask without those overrides and keep providers
    // enabled so the CLI can still list the model.
    mocks.capture.mockResolvedValue({ code: 0, stdout: 'openai/gpt-4o\n{"id":"gpt-4o","providerID":"openai","limit":{"context":128000,"output":16384}}\n' });
    const overlay = JSON.stringify({ provider: { openai: { models: { 'gpt-4o': {
      limit: { context: 250_000, output: 16_384 }, options: { max_completion_tokens: 7 },
    } } } } });
    await expect(readOpenCodeNativeModelLimits({
      command: 'opencode', cliMajor: 1, workingDirectory: '/tmp', env: { OPENCODE_CONFIG_CONTENT: overlay }, model: 'openai/gpt-4o',
    })).resolves.toEqual({ context: 128_000, output: 16_384 });
    const env = mocks.capture.mock.calls[0]?.[0]?.env as Record<string, string>;
    const read = JSON.parse(env['OPENCODE_CONFIG_CONTENT']!);
    expect(read.provider.openai.models['gpt-4o']).toEqual({ options: { max_completion_tokens: 7 } });
  });

  it('keys the cache per folder and overlay, sharing entries across ceilings', async () => {
    mocks.capture.mockResolvedValue({ code: 0, stdout: 'openai/gpt-4o\n{"id":"gpt-4o","providerID":"openai","limit":{"context":128000,"output":16384}}\n' });
    const overlayA = JSON.stringify({ provider: { openai: { models: { 'gpt-4o': { limit: { context: 250_000 } } } } } });
    const overlayB = JSON.stringify({ provider: { openai: { models: { 'gpt-4o': { limit: { context: 100_000 } } } } } });
    const overlayC = JSON.stringify({ provider: { openai: { models: { 'gpt-4o': { limit: { context: 100_000 } } } }, extra: { models: {} } } });
    const read = (env: Record<string, string>, workingDirectory = '/tmp') => readOpenCodeNativeModelLimits({
      command: 'opencode', cliMajor: 1, workingDirectory, env, model: 'openai/gpt-4o',
    });
    // Ceilings are stripped before every read, so overlays that differ only in
    // `limit` share one catalog read and one answer.
    await read({ OPENCODE_CONFIG_CONTENT: overlayA });
    await read({ OPENCODE_CONFIG_CONTENT: overlayB });
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    // A different folder or a different provider set is a different answer.
    await read({ OPENCODE_CONFIG_CONTENT: overlayB }, '/tmp/other');
    await read({ OPENCODE_CONFIG_CONTENT: overlayB }, '/tmp/other');
    await read({ OPENCODE_CONFIG_CONTENT: overlayC });
    expect(mocks.capture).toHaveBeenCalledTimes(3);
  });
});
