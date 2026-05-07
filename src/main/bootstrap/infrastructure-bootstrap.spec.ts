import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getBootstrapModules,
  resetBootstrapRegistryForTesting,
} from './index';
import { registerInfrastructureBootstrap } from './infrastructure-bootstrap';

const cliUpdatePoller = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('../cli/cli-update-poll-service', () => ({
  getCliUpdatePollService: () => cliUpdatePoller,
}));

describe('registerInfrastructureBootstrap', () => {
  afterEach(() => {
    resetBootstrapRegistryForTesting();
    vi.clearAllMocks();
  });

  it('registers the CLI update poller with explicit startup and teardown', async () => {
    registerInfrastructureBootstrap();

    const module = getBootstrapModules().find((item) => item.name === 'CLI update poller');

    expect(module).toBeDefined();
    expect(module?.domain).toBe('infrastructure');
    expect(module?.failureMode).toBe('degraded');

    await module?.init();
    expect(cliUpdatePoller.start).toHaveBeenCalledTimes(1);

    await module?.teardown?.();
    expect(cliUpdatePoller.stop).toHaveBeenCalledTimes(1);
  });
});
