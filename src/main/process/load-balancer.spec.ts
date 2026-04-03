import { describe, it, expect, beforeEach } from 'vitest';
import { LoadBalancer } from './load-balancer';

describe('LoadBalancer', () => {
  let balancer: LoadBalancer;

  beforeEach(() => {
    LoadBalancer._resetForTesting();
    balancer = LoadBalancer.getInstance();
  });

  it('should update load metrics', () => {
    balancer.updateMetrics('inst-1', {
      activeTasks: 2,
      contextUsagePercent: 50,
      memoryPressure: 'normal',
      status: 'busy',
    });
    const metrics = balancer.getMetrics('inst-1');
    expect(metrics?.activeTasks).toBe(2);
  });

  it('should select least loaded instance', () => {
    balancer.updateMetrics('inst-1', {
      activeTasks: 3,
      contextUsagePercent: 80,
      memoryPressure: 'normal',
      status: 'busy',
    });
    balancer.updateMetrics('inst-2', {
      activeTasks: 1,
      contextUsagePercent: 30,
      memoryPressure: 'normal',
      status: 'idle',
    });
    balancer.updateMetrics('inst-3', {
      activeTasks: 0,
      contextUsagePercent: 10,
      memoryPressure: 'normal',
      status: 'idle',
    });
    const selected = balancer.selectLeastLoaded(['inst-1', 'inst-2', 'inst-3']);
    expect(selected).toBe('inst-3');
  });

  it('should exclude instances at critical memory pressure', () => {
    balancer.updateMetrics('inst-1', {
      activeTasks: 0,
      contextUsagePercent: 10,
      memoryPressure: 'critical',
      status: 'idle',
    });
    balancer.updateMetrics('inst-2', {
      activeTasks: 2,
      contextUsagePercent: 60,
      memoryPressure: 'normal',
      status: 'busy',
    });
    const selected = balancer.selectLeastLoaded(['inst-1', 'inst-2']);
    expect(selected).toBe('inst-2');
  });

  it('should return null when no eligible instances', () => {
    const selected = balancer.selectLeastLoaded([]);
    expect(selected).toBeNull();
  });

  it('should penalize remote instances with high latency', () => {
    balancer.updateMetrics('local-1', {
      activeTasks: 1,
      contextUsagePercent: 50,
      memoryPressure: 'normal',
      status: 'busy',
    });
    balancer.updateMetrics('remote-1', {
      activeTasks: 1,
      contextUsagePercent: 50,
      memoryPressure: 'normal',
      status: 'busy',
      nodeLatencyMs: 200,
    });
    // Local should be preferred (lower score = less loaded)
    const selected = balancer.selectLeastLoaded(['local-1', 'remote-1']);
    expect(selected).toBe('local-1');
  });
});
