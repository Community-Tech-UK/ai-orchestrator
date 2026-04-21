import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bootstrapAll,
  registerBootstrapModule,
  resetBootstrapRegistryForTesting,
  teardownAll,
} from './index';

describe('bootstrap registry', () => {
  afterEach(() => {
    resetBootstrapRegistryForTesting();
    vi.restoreAllMocks();
  });

  it('bootstraps modules in dependency order', async () => {
    const order: string[] = [];

    registerBootstrapModule({
      name: 'child',
      domain: 'test',
      failureMode: 'degraded',
      dependencies: ['parent'],
      init: () => {
        order.push('child');
      },
    });
    registerBootstrapModule({
      name: 'parent',
      domain: 'test',
      failureMode: 'degraded',
      init: () => {
        order.push('parent');
      },
    });

    await bootstrapAll();

    expect(order).toEqual(['parent', 'child']);
  });

  it('collects degraded failures but throws on critical failures', async () => {
    registerBootstrapModule({
      name: 'degraded',
      domain: 'test',
      failureMode: 'degraded',
      init: () => {
        throw new Error('soft-fail');
      },
    });
    registerBootstrapModule({
      name: 'skip',
      domain: 'test',
      failureMode: 'skip',
      init: () => {
        throw new Error('skip-fail');
      },
    });

    await expect(bootstrapAll()).resolves.toEqual({
      failed: ['degraded', 'skip'],
    });

    resetBootstrapRegistryForTesting();
    registerBootstrapModule({
      name: 'critical',
      domain: 'test',
      failureMode: 'critical',
      init: () => {
        throw new Error('hard-fail');
      },
    });

    await expect(bootstrapAll()).rejects.toThrow('hard-fail');
  });

  it('tears modules down in reverse dependency order', async () => {
    const order: string[] = [];

    registerBootstrapModule({
      name: 'database',
      domain: 'test',
      failureMode: 'degraded',
      init: vi.fn(),
      teardown: () => {
        order.push('database');
      },
    });
    registerBootstrapModule({
      name: 'workers',
      domain: 'test',
      failureMode: 'degraded',
      dependencies: ['database'],
      init: vi.fn(),
      teardown: () => {
        order.push('workers');
      },
    });

    await bootstrapAll();
    await teardownAll();

    expect(order).toEqual(['workers', 'database']);
  });
});
