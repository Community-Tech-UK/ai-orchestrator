import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CliLatestVersionService, type CliLatestVersionServiceDeps } from '../cli-latest-version';
import type { CliType } from '../cli-detection';

describe('CliLatestVersionService', () => {
  let fetchNpmLatestVersion: Mock<NonNullable<CliLatestVersionServiceDeps['fetchNpmLatestVersion']>>;
  let nowMs: number;

  const makeService = (npmPackageFor?: (cli: CliType) => string | undefined) =>
    new CliLatestVersionService({
      fetchNpmLatestVersion,
      npmPackageFor: npmPackageFor ?? (() => '@anthropic-ai/claude-code'),
      cacheTtlMs: 1000,
      now: () => nowMs,
    });

  beforeEach(() => {
    nowMs = 10_000;
    fetchNpmLatestVersion = vi.fn().mockResolvedValue('2.0.0');
  });

  it.each([['1.19.1', 'opencode-ai', '1.19.2'], ['2.0.30', '@opencode/cli', '2.0.31']])('uses the matching OpenCode package for %s', async (installed, expectedPackage, latest) => {
    fetchNpmLatestVersion.mockResolvedValue(latest);
    const service = new CliLatestVersionService({ fetchNpmLatestVersion });
    expect(await service.resolveLatestVersion('opencode', false, installed)).toBe(latest);
    expect(fetchNpmLatestVersion).toHaveBeenCalledWith(expectedPackage, expect.any(Number));
  });

  it('does not offer a cross-major OpenCode update or guess when the installed version is unknown', async () => {
    fetchNpmLatestVersion.mockResolvedValue('3.0.0');
    const service = new CliLatestVersionService({ fetchNpmLatestVersion });
    expect(await service.resolveLatestVersion('opencode', false, '2.0.30')).toBeNull();
    expect(await service.resolveLatestVersion('opencode')).toBeNull();
  });

  it('returns null without fetching when the CLI has no npm package', async () => {
    const service = makeService(() => undefined);

    expect(await service.resolveLatestVersion('cursor')).toBeNull();
    expect(fetchNpmLatestVersion).not.toHaveBeenCalled();
  });

  it('fetches and returns the latest version', async () => {
    const service = makeService();

    expect(await service.resolveLatestVersion('claude')).toBe('2.0.0');
    expect(fetchNpmLatestVersion).toHaveBeenCalledWith('@anthropic-ai/claude-code', expect.any(Number));
  });

  it('serves a cached value within the TTL', async () => {
    const service = makeService();

    await service.resolveLatestVersion('claude');
    nowMs += 500; // still within 1000ms TTL
    await service.resolveLatestVersion('claude');

    expect(fetchNpmLatestVersion).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    const service = makeService();

    await service.resolveLatestVersion('claude');
    nowMs += 1500; // past TTL
    await service.resolveLatestVersion('claude');

    expect(fetchNpmLatestVersion).toHaveBeenCalledTimes(2);
  });

  it('force bypasses the cache', async () => {
    const service = makeService();

    await service.resolveLatestVersion('claude');
    await service.resolveLatestVersion('claude', true);

    expect(fetchNpmLatestVersion).toHaveBeenCalledTimes(2);
  });

  it('fails soft to null when the fetch rejects, and caches the miss', async () => {
    fetchNpmLatestVersion.mockRejectedValue(new Error('network down'));
    const service = makeService();

    expect(await service.resolveLatestVersion('claude')).toBeNull();
    // cached null is reused within the TTL (no retry storm)
    await service.resolveLatestVersion('claude');
    expect(fetchNpmLatestVersion).toHaveBeenCalledTimes(1);
  });
});
