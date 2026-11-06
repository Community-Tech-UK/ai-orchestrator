import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RtkSavingsTabComponent } from './rtk-savings-tab.component';
import { RtkIpcService, type RtkCoverageRow, type RtkStatusData } from '../../core/services/ipc/rtk-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';

await resolveComponentResources((url) => {
  if (url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

// The rows main's `describeRtkCoverage` returns for rtkAutoApproveScope 'trial' with RTK usable
// (`rtk-rollout.ts:282-346`): seven rows, surface/mode/note, mode one of four words.
const TRIAL_COVERAGE: RtkCoverageRow[] = [
  { surface: 'Claude asking for approval', mode: 'Hook', note: 'The approval hook also shortens command output.' },
  { surface: 'Claude auto-approve', mode: 'Trial', note: 'Half of sessions get the hook, so Harness can measure it.' },
  { surface: 'Loops', mode: 'Trial', note: 'Half of loop runs get the hook, so Harness can measure it.' },
  { surface: 'Codex', mode: 'Instructions only', note: 'Codex is asked to run commands through RTK in the shell tool.' },
  { surface: 'Copilot, Cursor, OpenCode, Grok', mode: 'Instructions only', note: 'Same instruction text; no hook is installed for these CLIs.' },
  { surface: 'Antigravity and Gemini', mode: 'Instructions only', note: 'Same instruction text; no hook is installed for these CLIs.' },
  { surface: 'Remote machines', mode: 'Off', note: 'Worker-machine sessions run their own CLIs; nothing is forwarded yet.' },
];

describe('RtkSavingsTabComponent trial line and coverage table (R6N4)', () => {
  const getSummary = vi.fn();
  const getStatus = vi.fn();

  const status = (overrides: Partial<RtkStatusData> = {}): { success: true; data: RtkStatusData } => ({
    success: true,
    data: {
      enabled: true, available: true, binarySource: 'bundled', version: '0.51.0',
      trackingDbPath: '/tmp/tracking.db', trackingDbAvailable: true,
      coverage: TRIAL_COVERAGE,
      ...overrides,
    },
  });

  beforeEach(() => {
    getSummary.mockReset().mockResolvedValue({ success: true, data: null });
    getStatus.mockReset().mockResolvedValue(status());
    TestBed.configureTestingModule({ providers: [
      { provide: RtkIpcService, useValue: { getSummary, getStatus, lastSummary: { value: null } } },
      { provide: SettingsStore, useValue: { rtkSettings: () => [], get: () => true, set: vi.fn() } },
    ] });
  });
  afterEach(() => TestBed.resetTestingModule());

  async function render() {
    const fixture = TestBed.createComponent(RtkSavingsTabComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  const text = (root: HTMLElement) => (root.textContent ?? '').replace(/\s+/g, ' ');

  it('shows the running trial with both session counts and its start date', async () => {
    getStatus.mockResolvedValue(status({ trial: { startedAt: '2026-10-09', sessionsWithHook: 93, sessionsWithout: 97 } }));
    const root = await render();
    expect(text(root)).toContain('Trial running: 93 sessions with RTK, 97 without. Started 2026-10-09.');
  });

  it('leaves out the start date when the trial has none yet, and still shows zero counts', async () => {
    getStatus.mockResolvedValue(status({ trial: { startedAt: null, sessionsWithHook: 0, sessionsWithout: 0 } }));
    const root = await render();
    expect(text(root)).toContain('Trial running: 0 sessions with RTK, 0 without.');
    expect(text(root)).not.toContain('Started');
  });

  it('shows no trial line when status carries no trial', async () => {
    expect(text(await render())).not.toContain('Trial running');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [
      { provide: RtkIpcService, useValue: { getSummary, getStatus, lastSummary: { value: null } } },
      { provide: SettingsStore, useValue: { rtkSettings: () => [], get: () => true, set: vi.fn() } },
    ] });
    getStatus.mockResolvedValue(status({ trial: null }));
    expect(text(await render())).not.toContain('Trial running');
  });

  it('renders every coverage row it is given, in order, with surface, mode and note', async () => {
    const root = await render();
    const rows = Array.from(root.querySelectorAll('table.rtk-table tbody tr'))
      .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim()));
    expect(rows).toEqual(TRIAL_COVERAGE.map((row) => [row.surface, row.mode, row.note]));
    expect(rows[1]?.[1], 'the first hook-eligible auto-approve row shows the Trial mode').toBe('Trial');
  });

  it('renders an empty coverage table body, not stale rows, when none are supplied', async () => {
    getStatus.mockResolvedValue(status({ coverage: [] }));
    const root = await render();
    expect(root.querySelectorAll('table.rtk-table tbody tr')).toHaveLength(0);
    expect(text(root)).toContain('Where it applies');
  });
});
