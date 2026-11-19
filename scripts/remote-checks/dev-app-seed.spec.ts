import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { seedExpression } = require('./dev-app-seed.js') as { seedExpression(stage: string): string };

/** Like Angular's: a function you call to read, carrying set and update. `value` is for the test to look at. */
interface Signal<T> { (): T; readonly value: T; set(next: T): void; update(change: (current: T) => T): void }
function signal<T>(initial: T): Signal<T> {
  let current = initial;
  const read = (() => current) as Signal<T>;
  read.set = (next) => { current = next; };
  read.update = (change) => { current = change(current); };
  Object.defineProperty(read, 'value', { get: () => current });
  return read;
}

/** A stand-in for the copy's window: components found through `ng.getComponent`, each holding the services it injected. */
function windowWith(parts: { screens?: Record<string, object>; holders?: object[]; withNg?: boolean; roleChoice?: boolean }) {
  const elements: object[] = [];
  const components = new Map<object, object>();
  const add = (component: object, selector?: string) => {
    const element = { selector };
    elements.push(element);
    components.set(element, component);
    return element;
  };
  for (const holder of parts.holders ?? []) add(holder);
  const bySelector = new Map<string, object>();
  for (const [selector, component] of Object.entries(parts.screens ?? {})) bySelector.set(selector, add(component, selector));
  const clicked: string[] = [];
  if (parts.roleChoice) {
    bySelector.set('app-role-choice', {
      querySelectorAll: () => [{ textContent: 'Another computer', click: () => clicked.push('other') },
        { textContent: 'Main Harness', click: () => { clicked.push('main'); bySelector.delete('app-role-choice'); } }],
    });
  }
  const storage = new Map<string, string>();
  const reloads: string[] = [];
  const sandbox: Record<string, unknown> = {
    document: { querySelectorAll: () => elements, querySelector: (selector: string) => bySelector.get(selector) ?? null },
    localStorage: { setItem: (key: string, value: string) => storage.set(key, value), getItem: (key: string) => storage.get(key) ?? null },
    location: { origin: 'http://localhost:4567', replace: (url: string) => reloads.push(url) },
    setTimeout: (run: () => void) => run(),
    Date, Map, WeakSet, JSON, Object, Array,
  };
  sandbox['window'] = parts.withNg === false ? sandbox : Object.assign(sandbox, { ng: { getComponent: (element: object) => components.get(element) } });
  const run = (stage: string) => JSON.parse(runInNewContext(seedExpression(stage), sandbox) as string) as { applied: string[]; waiting: string[]; error?: string };
  return { run, storage, reloads, clicked };
}

describe('dev-app seed fixtures', () => {
  it('refuses a stage it does not know', () => {
    expect(() => seedExpression('delete-everything')).toThrow(/unknown seed stage/);
  });

  it('marks first-run setup done and reloads the screens once', () => {
    const page = windowWith({});
    expect(page.run('prepare').applied).toEqual(['first-run setup marked done']);
    expect(page.storage.get('aiorch.setup.completed')).toBe('1');
    expect(page.reloads).toEqual(['http://localhost:4567/']);
  });

  it('leaves an open screen where it is when first-run setup is already marked done', () => {
    const page = windowWith({});
    page.run('prepare');
    page.reloads.length = 0;
    expect(page.run('prepare').applied).toEqual([]);
    expect(page.reloads).toEqual([]);
  });

  it('says so when the screens were not built for development', () => {
    expect(windowWith({ withNg: false }).run('fill').error).toMatch(/no window\.ng/);
  });

  it('fills the AI tool list, the sessions and their queues through the stores, and chooses the main Harness role', () => {
    const state = signal({ clis: [] as unknown[], selectedCli: null as string | null, loading: true, initialized: false });
    const cliStore = { noClisError: () => null, state };
    const queues = signal(new Map<string, unknown[]>());
    const added: { id: string; displayName: string; status: string }[] = [];
    const selected: string[] = [];
    const instanceStore = {
      addInstanceFromData: (data: { id: string; displayName: string; status: string }) => added.push(data),
      setSelectedInstance: (id: string) => selected.push(id),
      stateService: { messageQueue: queues },
    };
    const page = windowWith({ holders: [{ cliStore }, { store: instanceStore }], roleChoice: true });
    const first = page.run('fill');
    expect(first.applied).toEqual(['role choice: main Harness', 'AI tools shown as installed', 'two sessions with queued messages']);
    expect(page.clicked).toEqual(['main']);
    expect(state.value).toMatchObject({ selectedCli: 'claude', loading: false, initialized: true });
    expect((state.value.clis as { installed: boolean }[]).every(cli => cli.installed)).toBe(true);
    expect(added.map(session => [session.id, session.status])).toEqual([['fixture-idle', 'idle'], ['fixture-busy', 'busy']]);
    expect(added.every(session => session.displayName.endsWith('(test fixture)'))).toBe(true);
    expect(queues.value.get('fixture-busy')).toEqual([
      { message: 'Queued message one (test fixture)', kind: 'queue' },
      { message: 'Steering message (test fixture)', kind: 'steer' },
    ]);
    expect(selected).toEqual(['fixture-busy']);
    expect(first.waiting).toEqual(['open the Browser screen for its fixtures', 'open Plan Queue account rules for their fixtures']);
    // Running it again adds nothing twice.
    expect(page.run('fill').applied).toEqual([]);
    expect(added).toHaveLength(2);
  });

  it('waits for the stores that are not on screen yet, naming them', () => {
    expect(windowWith({}).run('fill').waiting).toEqual([
      'AI tool list', 'session list', 'open the Browser screen for its fixtures', 'open Plan Queue account rules for their fixtures',
    ]);
  });

  it('fills the Browser and account screens when they are open, once each, labelled as fixtures', () => {
    const browser = {
      profiles: signal<unknown[]>([]), targets: signal<{ id: string; title: string }[]>([]),
      selectedProfileId: signal<string | null>(null), selectedTargetId: signal<string | null>(null),
    };
    const accounts = {
      pooledAccounts: signal<{ id: string; label: string; enabled: boolean }[]>([]), pooledLoaded: signal(false),
      entries: signal(new Map<string, { choice: string }>()),
    };
    const page = windowWith({ screens: { 'app-browser-page': browser, 'app-plan-queue-account-rules-panel': accounts } });
    expect(page.run('fill').applied).toEqual(['Browser profile and page', 'unavailable accounts in the Plan Queue account rules']);
    expect(browser.targets.value).toEqual([expect.objectContaining({ id: 'fixture-target', title: 'Browser page (test fixture)' })]);
    expect(browser.selectedTargetId.value).toBe('fixture-target');
    expect(accounts.pooledAccounts.value).toEqual([expect.objectContaining({ id: 'fixture-off', enabled: false })]);
    expect(accounts.pooledLoaded.value).toBe(true);
    expect([...accounts.entries.value.keys()]).toEqual(['claude:fixture-off', 'claude:fixture-gone']);
    // Edits made since are not overwritten by a second run.
    browser.targets.set([]);
    expect(page.run('fill').applied).toEqual([]);
    expect(browser.targets.value).toEqual([]);
  });
});
