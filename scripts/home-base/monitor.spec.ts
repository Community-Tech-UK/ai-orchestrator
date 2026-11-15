import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
interface Job {
  id: string; name: string; enabled: boolean; nextRunAt: number | null; maxRunMinutes: number;
  lastRun: { status: string; at: number; result: { outcome: string; notify: boolean } | null;
    maxRunMinutes: number | null; paused: boolean; deadlineAt: number | null } | null;
}
interface Alert { id: string; subject: string; text: string }
interface State {
  version: 1; downSince: number | null; outageNotified: boolean;
  enabledById: Record<string, boolean>; activeAlerts: string[]; outbox: Alert[];
}
const { initialMonitorState, evaluateMonitorCheck, validateGatewayUrl, validateJobs, acknowledgeAlert } = require('./monitor-core.js') as {
  initialMonitorState(): State;
  evaluateMonitorCheck(state: State, observation: { jobs?: Job[]; peerReachable: boolean }, now: number): State;
  validateGatewayUrl(value: string): URL;
  validateJobs(value: unknown): Job[];
  acknowledgeAlert(state: State, id: string): State;
};
const MINUTE = 60_000;
const job = (patch: Partial<Job> = {}): Job => ({ id: 'daily', name: 'Daily report', enabled: true,
  nextRunAt: 1_000_000_000, maxRunMinutes: 90, lastRun: null, ...patch });
const lastRun = (patch: Partial<NonNullable<Job['lastRun']>> = {}): NonNullable<Job['lastRun']> => ({
  status: 'succeeded', at: 1000, result: null, maxRunMinutes: 90, paused: false, deadlineAt: null, ...patch,
});

describe('home-base monitor', () => {
  it('waits thirty minutes, reports which connections failed, deduplicates the outage and reports recovery', () => {
    let state = evaluateMonitorCheck(initialMonitorState(), { peerReachable: false }, 1000);
    expect(state.outbox).toEqual([]);
    state = evaluateMonitorCheck(state, { peerReachable: true }, 1000 + 29 * MINUTE);
    expect(state.outbox).toEqual([]);
    state = evaluateMonitorCheck(state, { peerReachable: false }, 1000 + 30 * MINUTE);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0].text).toContain('could not reach either');
    const outage = state.outbox[0];
    state = acknowledgeAlert(state, outage.id);
    state = evaluateMonitorCheck(state, { peerReachable: true }, 1000 + 45 * MINUTE);
    expect(state.outbox).toEqual([]);
    state = evaluateMonitorCheck(state, { jobs: [job()], peerReachable: true }, 1000 + 60 * MINUTE);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0].subject).toContain('reachable again');
    expect(state.downSince).toBeNull();
  });

  it('attributes a home-base-only connection failure without declaring the home base itself down', () => {
    let state = evaluateMonitorCheck(initialMonitorState(), { peerReachable: true }, 1000);
    state = evaluateMonitorCheck(state, { peerReachable: true }, 1000 + 30 * MINUTE);
    expect(state.outbox[0].text).toContain('other computer answered');
    expect(state.outbox[0].text).toContain('PC could not reach the home base');
  });

  it('does not email recovery after a brief connection failure or alert for an initially disabled job', () => {
    const down = evaluateMonitorCheck(initialMonitorState(), { peerReachable: true }, 1000);
    const recovered = evaluateMonitorCheck(down, { jobs: [job({ enabled: false })], peerReachable: true }, 1000 + MINUTE);
    expect(recovered.outbox).toEqual([]);
  });

  it.each([
    ['failed', job({ lastRun: lastRun({ status: 'failed' }) })],
    ['skipped', job({ lastRun: lastRun({ status: 'skipped' }) })],
    ['paused', job({ lastRun: lastRun({ status: 'running', paused: true }) })],
    ['needs attention', job({ lastRun: lastRun({ result: { outcome: 'needs_attention', notify: false } }) })],
    ['run limit', job({ lastRun: lastRun({ status: 'running', deadlineAt: 500 }) })],
    ['late', job({ nextRunAt: 1000 })],
  ])('reports and deduplicates a %s job, including when the job itself asked for no notification', (_reason, item) => {
    let state = evaluateMonitorCheck(initialMonitorState(), { jobs: [item], peerReachable: true }, 31 * MINUTE);
    expect(state.outbox).toHaveLength(1);
    const alert = state.outbox[0];
    expect(alert.text).toContain('Daily report');
    state = acknowledgeAlert(state, alert.id);
    state = evaluateMonitorCheck(state, { jobs: [item], peerReachable: true }, 46 * MINUTE);
    expect(state.outbox).toEqual([]);
  });

  it('notices when a job becomes disabled and when a later run fails again', () => {
    let state = evaluateMonitorCheck(initialMonitorState(), { jobs: [job()], peerReachable: true }, 1000);
    state = evaluateMonitorCheck(state, { jobs: [job({ enabled: false })], peerReachable: true }, 2000);
    expect(state.outbox[0].text).toContain('switched off');
    state = acknowledgeAlert(state, state.outbox[0].id);
    state = evaluateMonitorCheck(state, { jobs: [job({ lastRun: lastRun({ status: 'failed', at: 3000 }) })], peerReachable: true }, 4000);
    expect(state.outbox).toHaveLength(1);
    state = acknowledgeAlert(state, state.outbox[0].id);
    state = evaluateMonitorCheck(state, { jobs: [job({ lastRun: lastRun({ status: 'failed', at: 5000 }) })], peerReachable: true }, 6000);
    expect(state.outbox).toHaveLength(1);
  });

  it('retains undelivered alerts in the outbox across checks without adding duplicates', () => {
    const item = job({ lastRun: lastRun({ status: 'failed' }) });
    const first = evaluateMonitorCheck(initialMonitorState(), { jobs: [item], peerReachable: true }, 1000);
    const reloaded = JSON.parse(JSON.stringify(first)) as State;
    expect(evaluateMonitorCheck(reloaded, { jobs: [item], peerReachable: true }, 2000).outbox).toEqual(first.outbox);
  });

  it.each(['http://example.com:4889', 'http://127.0.0.1:4889', 'http://192.168.1.1:4889',
    'http://100.64.0.1:4889/other', 'http://name:EXAMPLE_PASSWORD@100.64.0.1:4889'])('refuses a non-tailnet or ambiguous gateway URL: %s', value => {
    expect(() => validateGatewayUrl(value)).toThrow();
  });
  it.each(['http://100.64.0.1:4889', 'http://[fd7a:115c:a1e0::1]:4889'])('accepts a private tailnet address: %s', value => {
    expect(validateGatewayUrl(value).port).toBe('4889');
  });

  it.each([{}, { error: 'refused' }, [{ id: 'old-host-job', enabled: true }],
    [job(), job()], [job({ lastRun: lastRun({ status: 'unexpected' }) })]].map(payload => ({ payload })))('rejects a wrong, old or incomplete authenticated response', ({ payload }) => {
    expect(() => validateJobs(payload)).toThrow();
  });
  it('accepts empty lists and a complete safe projection from the intended build', () => {
    expect(validateJobs([])).toEqual([]);
    expect(validateJobs([job()])).toEqual([job()]);
  });
});
