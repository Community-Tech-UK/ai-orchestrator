import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const sourcePath = 'resources/browser-extension/browser-session-claims.js';

function harness() {
  let now = 1_000;
  const stored: Record<string, unknown> = {};
  const storage = {
    get: async (key: string) => ({ [key]: stored[key] }),
    set: async (value: Record<string, unknown>) => { Object.assign(stored, structuredClone(value)); },
  };
  const make = () => runInNewContext(`${readFileSync(sourcePath, 'utf8')}; createBrowserSessionClaims`, {})({
    storage, now: () => now, leaseMs: 30_000,
  }) as {
    authorize: (command: Record<string, unknown>) => Promise<void>;
    rememberOpened: (command: Record<string, unknown>, result: unknown) => Promise<void>;
    forget: (tabId: number) => Promise<void>;
  };
  return { make, later: (ms: number) => { now += ms; } };
}

const command = (owner: string | undefined, tabId = 7) => ({
  command: 'snapshot', target: { tabId }, ...(owner ? { sessionOwner: owner } : {}),
});

describe('shared Chrome session tab claims', () => {
  it('allows each session its own tab and refuses taking another session\'s tab across native links', async () => {
    const claims = harness().make();
    await claims.authorize(command('SESSION_A_PLACEHOLDER'));
    await expect(claims.authorize(command('SESSION_A_PLACEHOLDER'))).resolves.toBeUndefined();
    await expect(claims.authorize(command('SESSION_B_PLACEHOLDER'))).rejects.toThrow(/browser_tab_held_by_another_session/);
    await expect(claims.authorize(command('SESSION_B_PLACEHOLDER', 8))).resolves.toBeUndefined();
    await expect(claims.authorize(command(undefined))).rejects.toThrow(/browser_tab_held_by_another_session/);
  });

  it('keeps claims across extension restarts and expires an idle session', async () => {
    const fixture = harness();
    await fixture.make().authorize(command('SESSION_A_PLACEHOLDER'));
    const restarted = fixture.make();
    await expect(restarted.authorize(command('SESSION_B_PLACEHOLDER'))).rejects.toThrow(/browser_tab_held/);
    fixture.later(30_001);
    await expect(restarted.authorize(command('SESSION_B_PLACEHOLDER'))).resolves.toBeUndefined();
  });

  it('claims a newly opened tab before publishing it, and removes the claim when Chrome closes it', async () => {
    const claims = harness().make();
    await claims.rememberOpened({ command: 'open_tab', sessionOwner: 'SESSION_A_PLACEHOLDER' }, { tabId: 8 });
    await expect(claims.authorize(command('SESSION_B_PLACEHOLDER', 8))).rejects.toThrow(/browser_tab_held/);
    await claims.forget(8);
    await expect(claims.authorize(command('SESSION_B_PLACEHOLDER', 8))).resolves.toBeUndefined();
  });

  it('does not let a rejected claim poison later work on another tab', async () => {
    const claims = harness().make();
    await claims.authorize(command('SESSION_A_PLACEHOLDER'));
    await claims.authorize(command('SESSION_B_PLACEHOLDER')).catch(() => undefined);
    await expect(claims.authorize(command('SESSION_B_PLACEHOLDER', 9))).resolves.toBeUndefined();
  });
});
