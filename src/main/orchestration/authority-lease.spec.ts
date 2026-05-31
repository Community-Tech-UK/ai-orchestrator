import { describe, it, expect } from 'vitest';
import { AuthorityLeaseRegistry, DEFAULT_LEASE_TTL_MS } from './authority-lease';

describe('AuthorityLeaseRegistry', () => {
  it('grants a free lane and reports the owner', () => {
    const r = new AuthorityLeaseRegistry();
    const res = r.acquire('wt-1', 'agent-A', DEFAULT_LEASE_TTL_MS, 0);
    expect(res).toMatchObject({ ok: true, owner: 'agent-A', tookOver: false });
    expect(r.owner('wt-1', 0)).toBe('agent-A');
    expect(r.isHeldBy('wt-1', 'agent-A', 0)).toBe(true);
  });

  it('blocks a second owner while the lease is fresh', () => {
    const r = new AuthorityLeaseRegistry();
    r.acquire('wt-1', 'agent-A', 1000, 0);
    const res = r.acquire('wt-1', 'agent-B', 1000, 500);
    expect(res).toMatchObject({ ok: false, owner: 'agent-A', blockedBy: 'agent-A' });
    expect(r.owner('wt-1', 500)).toBe('agent-A');
  });

  it('lets the same owner renew via re-acquire (extends the lease)', () => {
    const r = new AuthorityLeaseRegistry();
    r.acquire('wt-1', 'agent-A', 1000, 0);
    const res = r.acquire('wt-1', 'agent-A', 1000, 900);
    expect(res.ok).toBe(true);
    // Renewed at 900 → still owner at 1800 (would have expired at 1000 otherwise).
    expect(r.owner('wt-1', 1800)).toBe('agent-A');
  });

  it('allows stale takeover after the lease expires', () => {
    const r = new AuthorityLeaseRegistry();
    r.acquire('wt-1', 'agent-A', 1000, 0);
    expect(r.owner('wt-1', 1000)).toBeNull(); // expired at exactly ttl
    const res = r.acquire('wt-1', 'agent-B', 1000, 1000);
    expect(res).toMatchObject({ ok: true, owner: 'agent-B', tookOver: true });
  });

  it('renew fails for a non-owner or after expiry', () => {
    const r = new AuthorityLeaseRegistry();
    r.acquire('wt-1', 'agent-A', 1000, 0);
    expect(r.renew('wt-1', 'agent-B', 100)).toBe(false);
    expect(r.renew('wt-1', 'agent-A', 100)).toBe(true);
    expect(r.renew('wt-1', 'agent-A', 5000)).toBe(false); // expired (last renew 100, ttl 1000)
  });

  it('release frees the lane only for the owner', () => {
    const r = new AuthorityLeaseRegistry();
    r.acquire('wt-1', 'agent-A', 1000, 0);
    expect(r.release('wt-1', 'agent-B')).toBe(false);
    expect(r.release('wt-1', 'agent-A')).toBe(true);
    expect(r.owner('wt-1', 0)).toBeNull();
  });

  it('lists active lanes and prunes expired ones', () => {
    const r = new AuthorityLeaseRegistry();
    r.acquire('a', 'A', 1000, 0);
    r.acquire('b', 'B', 5000, 0);
    expect(r.activeLanes(0).map((l) => l.lane).sort()).toEqual(['a', 'b']);
    expect(r.activeLanes(2000).map((l) => l.lane)).toEqual(['b']);
    expect(r.prune(2000)).toBe(1);
    expect(r.activeLanes(2000).map((l) => l.lane)).toEqual(['b']);
  });
});
