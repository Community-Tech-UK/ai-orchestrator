/**
 * Plan 14c: quick ask refuses while the session cannot safely answer, and says
 * so in plain words. Two refusals the main spec does not cover. Suffix R6N6.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceManager } from './instance-manager';

const loans = vi.hoisted(() => ({
  isAdapterOnLoan: vi.fn(() => false),
  isRuntimeChangeInFlight: vi.fn(() => false),
}));
vi.mock('./lifecycle/adapter-loan-registry', () => loans);
vi.mock('../core/system/model-call-recorder', () => ({ recordModelCall: vi.fn() }));

import { askQuick } from './quick-ask-service';

const claudeInstance = {
  id: 'one',
  provider: 'claude',
  currentModel: 'claude-sonnet',
  outputBuffer: [{ id: 'm', type: 'assistant', content: 'answer', timestamp: 1 }],
} as unknown as Instance;

const adapter = (residentSession: boolean) => ({
  requestControl: vi.fn().mockResolvedValue({ ok: true, payload: { response: 'yes' } }),
  getAdapterCapabilities: () => ({ residentSession }),
});

const managerFor = (cli: unknown) => ({
  getInstance: () => claudeInstance,
  getAdapter: () => cli,
} as unknown as InstanceManager);

describe('askQuick refusals (R6N6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loans.isAdapterOnLoan.mockReturnValue(false);
    loans.isRuntimeChangeInFlight.mockReturnValue(false);
  });

  it('refuses while a runtime change is in flight, without asking the session', async () => {
    const cli = adapter(true);
    loans.isRuntimeChangeInFlight.mockReturnValue(true);
    const result = await askQuick(managerFor(cli), 'one', 'what did we decide?');
    expect(result).toEqual({ ok: false, code: 'loop', message: 'A loop is using this session right now.' });
    expect(loans.isRuntimeChangeInFlight).toHaveBeenCalledWith('one');
    expect(cli.requestControl).not.toHaveBeenCalled();
  });

  it('refuses when the adapter can take control requests but has no resident session', async () => {
    const cli = adapter(false);
    const result = await askQuick(managerFor(cli), 'one', 'what did we decide?');
    expect(result).toEqual({
      ok: false, code: 'not-running', message: 'This session is not running right now.',
    });
    expect(cli.requestControl).not.toHaveBeenCalled();
  });

  it('asks normally when the session is resident and nothing is changing', async () => {
    const cli = adapter(true);
    expect(await askQuick(managerFor(cli), 'one', 'what did we decide?'))
      .toMatchObject({ ok: true, answer: 'yes' });
    expect(cli.requestControl).toHaveBeenCalledTimes(1);
  });
});
