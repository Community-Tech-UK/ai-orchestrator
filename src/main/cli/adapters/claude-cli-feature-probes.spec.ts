import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const cache = vi.hoisted(() => ({ peek: vi.fn() }));
vi.mock('../cli-detection', () => ({ getCliDetectionService: () => ({ peekCachedResult: cache.peek }) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
import { isKnownOlderThan, resolveClaudeCliVersion } from './claude-cli-feature-probes';
import { ClaudeCliAdapter } from './claude-cli-adapter';
import type { CliStatus } from './base-cli-adapter';

describe('Claude version resolution', () => {
  beforeEach(() => { cache.peek.mockReset(); cache.peek.mockReturnValue(null); });
  it('adapter version wins, detected version is the fallback, otherwise null', () => {
    cache.peek.mockReturnValue({ detected: [{ name: 'claude', version: '2.1.296' }] });
    expect(resolveClaudeCliVersion('2.1.268')).toBe('2.1.268');
    expect(resolveClaudeCliVersion(null)).toBe('2.1.296');
    cache.peek.mockReturnValue(null);
    expect(resolveClaudeCliVersion(undefined)).toBeNull();
    expect(resolveClaudeCliVersion('unknown')).toBeNull();
  });
  it('known-old check rejects missing and malformed versions', () => {
    expect(isKnownOlderThan('2.1.266', '2.1.267')).toBe(true);
    for (const version of [null, undefined, 'unknown', 'bad', '2.1.267', '2.1.296']) expect(isKnownOlderThan(version, '2.1.267')).toBe(false);
  });
  it('loop-style auto-approve gets the cache flag from detection without a version subprocess', async () => {
    cache.peek.mockReturnValue({ detected: [{ name: 'claude', version: '2.1.296' }] });
    const adapter = new ClaudeCliAdapter({ yoloMode: true, excludeDynamicSystemPromptSections: true });
    const internals = adapter as unknown as { primeCliVersion(): Promise<void>; buildArgs(message: unknown): string[]; excludeDynamicSectionsSupported: boolean };
    internals.excludeDynamicSectionsSupported = true;
    const check = vi.spyOn(adapter, 'checkStatus');
    await internals.primeCliVersion();
    expect(check).not.toHaveBeenCalled();
    expect(internals.buildArgs({})).toContain('--exclude-dynamic-system-prompt-sections');
  });
  it.each(['2.1.296', '2.1.266'])('worker-style empty cache reads %s once and applies both gates', async version => {
    const adapter = new ClaudeCliAdapter({ yoloMode: true, resume: true, systemPrompt: 'STUB_OVERLAY', excludeDynamicSystemPromptSections: true });
    const internals = adapter as unknown as { primeCliVersion(): Promise<void>; buildArgs(message: unknown): string[]; cachedCliStatus: CliStatus; excludeDynamicSectionsSupported: boolean };
    internals.excludeDynamicSectionsSupported = true;
    const check = vi.spyOn(adapter, 'checkStatus').mockImplementation(async () => { internals.cachedCliStatus = { available: true, version }; return internals.cachedCliStatus; });
    await internals.primeCliVersion(); await internals.primeCliVersion();
    expect(check).toHaveBeenCalledOnce();
    const args = internals.buildArgs({});
    expect(args.includes('--exclude-dynamic-system-prompt-sections')).toBe(version === '2.1.296');
    expect(args.includes('--append-system-prompt')).toBe(version === '2.1.266');
  });
});


describe('optional worker version probe failure', () => {
  it('fails soft and omits the cache flag if the version subprocess cannot start', async () => {
    cache.peek.mockReturnValue(null);
    const adapter = new ClaudeCliAdapter({ yoloMode: true, excludeDynamicSystemPromptSections: true });
    const internals = adapter as unknown as { primeCliVersion(): Promise<void>; buildArgs(message: unknown): string[]; excludeDynamicSectionsSupported: boolean };
    internals.excludeDynamicSectionsSupported = true;
    vi.spyOn(adapter, 'checkStatus').mockRejectedValue(new Error('stub unavailable'));
    await expect(internals.primeCliVersion()).resolves.toBeUndefined();
    expect(internals.buildArgs({})).not.toContain('--exclude-dynamic-system-prompt-sections');
  });
});


describe('worker version subprocess seam', () => {
  it.each(['2.1.266', '2.1.296'])('uses the actual status parser once for a CLI reporting %s', async version => {
    cache.peek.mockReturnValue(null);
    const adapter = new ClaudeCliAdapter({ yoloMode: true, excludeDynamicSystemPromptSections: true, resume: true, systemPrompt: 'STUB_OVERLAY' });
    const internals = adapter as unknown as { primeCliVersion(): Promise<void>; buildArgs(message: unknown): string[]; excludeDynamicSectionsSupported: boolean; spawnProcess(args: string[]): ChildProcess };
    internals.excludeDynamicSectionsSupported = true;
    const spawn = vi.spyOn(internals, 'spawnProcess').mockImplementation(() => {
      const child = new EventEmitter();
      const stdout = new EventEmitter(); const stderr = new EventEmitter();
      Object.assign(child, { stdout, stderr, kill: vi.fn() });
      queueMicrotask(() => { stdout.emit('data', `${version} (Claude Code)`); child.emit('close', 0); });
      return child as ChildProcess;
    });
    await internals.primeCliVersion(); await internals.primeCliVersion();
    expect(spawn).toHaveBeenCalledExactlyOnceWith(['--version']);
    expect((await adapter.checkStatus()).version).toBe(version);
    const args = internals.buildArgs({});
    expect(args.includes('--exclude-dynamic-system-prompt-sections')).toBe(version === '2.1.296');
    expect(args.includes('--append-system-prompt')).toBe(version === '2.1.266');
  });
});
