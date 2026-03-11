import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PoolManager } from './pool-manager';

describe('PoolManager', () => {
  let pool: PoolManager;

  beforeEach(() => {
    PoolManager._resetForTesting();
    pool = PoolManager.getInstance();
  });

  it('should initialize with default config', () => {
    expect(pool.getConfig().minPoolSize).toBe(0);
    expect(pool.getConfig().maxPoolSize).toBe(5);
  });

  it('should track pool size', () => {
    pool.addToPool('inst-1', { provider: 'claude', workingDirectory: '/tmp' });
    expect(pool.getPoolSize()).toBe(1);
    expect(pool.getAvailable()).toBe(1);
  });

  it('should acquire from pool', () => {
    pool.addToPool('inst-1', { provider: 'claude', workingDirectory: '/tmp' });
    const acquired = pool.acquire({ provider: 'claude' });
    expect(acquired).toBe('inst-1');
    expect(pool.getPoolSize()).toBe(0);
  });

  it('should return null when pool is empty', () => {
    const acquired = pool.acquire({ provider: 'claude' });
    expect(acquired).toBeNull();
  });

  it('should match by provider', () => {
    pool.addToPool('inst-1', { provider: 'claude', workingDirectory: '/tmp' });
    pool.addToPool('inst-2', { provider: 'codex', workingDirectory: '/tmp' });
    const acquired = pool.acquire({ provider: 'codex' });
    expect(acquired).toBe('inst-2');
    expect(pool.getPoolSize()).toBe(1);
  });

  it('should not exceed maxPoolSize', () => {
    pool.configure({ maxPoolSize: 2 });
    expect(pool.addToPool('inst-1', { provider: 'claude', workingDirectory: '/tmp' })).toBe(true);
    expect(pool.addToPool('inst-2', { provider: 'claude', workingDirectory: '/tmp' })).toBe(true);
    expect(pool.addToPool('inst-3', { provider: 'claude', workingDirectory: '/tmp' })).toBe(false);
    expect(pool.getPoolSize()).toBe(2);
  });

  it('should evict stale instances on acquire', () => {
    vi.useFakeTimers();
    pool.configure({ maxIdleTimeMs: 1000 });
    pool.addToPool('inst-1', { provider: 'claude', workingDirectory: '/tmp' });
    // Advance time past maxIdleTimeMs
    vi.advanceTimersByTime(2000);
    const acquired = pool.acquire({ provider: 'claude' });
    expect(acquired).toBeNull();
    expect(pool.getPoolSize()).toBe(0);
    vi.useRealTimers();
  });

  it('should emit pool:needs-warm when below minPoolSize on check', () => {
    vi.useFakeTimers();
    pool.configure({ minPoolSize: 2, enableAutoWarm: true, warmupIntervalMs: 500 });
    pool.start();
    const warmSpy = vi.fn();
    pool.on('pool:needs-warm', warmSpy);
    vi.advanceTimersByTime(600);
    expect(warmSpy).toHaveBeenCalledWith({ count: 2 });
    pool.stop();
    vi.useRealTimers();
  });

  it('should return correct stats', () => {
    pool.addToPool('inst-1', { provider: 'claude', workingDirectory: '/tmp' });
    const stats = pool.getStats();
    expect(stats.poolSize).toBe(1);
    expect(stats.maxPoolSize).toBe(5);
    expect(stats.minPoolSize).toBe(0);
  });

  it('should emit instance:evicted on stale eviction', () => {
    vi.useFakeTimers();
    pool.configure({ maxIdleTimeMs: 1000 });
    pool.addToPool('inst-stale', { provider: 'claude', workingDirectory: '/tmp' });
    const evictSpy = vi.fn();
    pool.on('instance:evicted', evictSpy);
    vi.advanceTimersByTime(2000);
    // Trigger eviction via acquire
    pool.acquire({});
    expect(evictSpy).toHaveBeenCalledWith({ instanceId: 'inst-stale', reason: 'stale' });
    vi.useRealTimers();
  });
});
