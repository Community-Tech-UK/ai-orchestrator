import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CostTracker } from '../../../core/system/cost-tracker';

// Inject a FRESH real CostTracker per test (the class is kept; only the singleton
// accessor is overridden). Using the real tracker means the test drives the actual
// `cost-recorded` / `budget-alert` domain events — the event NAMES are what the
// production bug got wrong, so exercising them guards against regression.
const holder = vi.hoisted(() => ({ tracker: null as CostTracker | null }));

vi.mock('../../../core/system/cost-tracker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/system/cost-tracker')>();
  return { ...actual, getCostTracker: () => holder.tracker };
});

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle },
}));

import { registerCostHandlers } from '../cost-handlers';

interface Sent {
  channel: string;
  data: unknown;
}

function setup(): { tracker: CostTracker; sent: Sent[] } {
  const sent: Sent[] = [];
  const windowManager = {
    getMainWindow: () => ({
      webContents: { send: (channel: string, data: unknown) => sent.push({ channel, data }) },
    }),
    sendToRenderer: (channel: string, data: unknown) => sent.push({ channel, data }),
  };
  registerCostHandlers({ windowManager: windowManager as never });
  return { tracker: holder.tracker!, sent };
}

describe('cost-handlers event forwarding', () => {
  beforeEach(() => {
    holder.tracker = new CostTracker();
    electronMocks.handle.mockClear();
  });

  it('forwards a recorded turn on cost:usage-recorded (real cost-recorded event)', () => {
    const { tracker, sent } = setup();
    tracker.recordUsage('inst-1', 'sess-1', 'claude-opus-4-8', 100, 200, 0, 0, 0.42);

    const usage = sent.filter((s) => s.channel === 'cost:usage-recorded');
    expect(usage).toHaveLength(1);
    expect((usage[0].data as { instanceId: string; cost: number }).instanceId).toBe('inst-1');
    expect((usage[0].data as { cost: number }).cost).toBe(0.42);
  });

  it('forwards a budget warning (<100%) on cost:budget-warning with a message', () => {
    const { tracker, sent } = setup();
    tracker.setBudget({ enabled: true, perSessionLimit: 5, alertThresholds: [50] });
    // $3 of a $5 session limit = 60% → crosses the 50% threshold, still under limit.
    tracker.recordUsage('inst-1', 'sess-1', 'model', 0, 0, 0, 0, 3);

    const warnings = sent.filter((s) => s.channel === 'cost:budget-warning');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const data = warnings[0].data as { message: string; exceeded: boolean; type: string };
    expect(data.exceeded).toBe(false);
    expect(data.type).toBe('session');
    expect(data.message).toContain('session budget at');
    // No exceeded alert should fire while under the limit.
    expect(sent.some((s) => s.channel === 'cost:budget-exceeded')).toBe(false);
  });

  it('forwards an over-limit alert on cost:budget-exceeded', () => {
    const { tracker, sent } = setup();
    tracker.setBudget({ enabled: true, perSessionLimit: 5, alertThresholds: [50, 100] });
    // $10 of a $5 session limit = 200% → over the limit.
    tracker.recordUsage('inst-1', 'sess-1', 'model', 0, 0, 0, 0, 10);

    const exceeded = sent.filter((s) => s.channel === 'cost:budget-exceeded');
    expect(exceeded.length).toBeGreaterThanOrEqual(1);
    expect((exceeded[0].data as { exceeded: boolean }).exceeded).toBe(true);
  });

  it('does not emit budget alerts when budgeting is disabled (default)', () => {
    const { tracker, sent } = setup();
    tracker.recordUsage('inst-1', 'sess-1', 'model', 0, 0, 0, 0, 9999);
    expect(sent.some((s) => s.channel.startsWith('cost:budget-'))).toBe(false);
    // usage push still fires.
    expect(sent.some((s) => s.channel === 'cost:usage-recorded')).toBe(true);
  });
});
