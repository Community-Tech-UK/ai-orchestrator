'use strict';
/**
 * Fixtures for a live-test copy that has no signed-in AI tool (`dev-app.js seed --port <port>`). A copy on a computer with
 * no AI tool installed shows "No AI CLI Found" and nothing else, so the composer, the queued messages, an unavailable
 * account and a Browser target can't be reached. This fills the copy's own screens (renderer state only) with labelled
 * stand-ins, through the screens' real stores and components, so the real templates render them. It reaches no
 * provider, account, browser or file: nothing is saved by the main process, and a restart of the copy clears it all.
 *
 * It works only on a screens build made for development, which keeps Angular's `window.ng` (dev-app.js builds those). Run
 * it again after opening the Browser or Plan Queue screen: each screen's fixtures are applied when that screen is open.
 * `pageSeed` runs in the copy's window, so it uses nothing from this file; it is sent as its own source text.
 */

const FIXTURE_PREFIX = 'fixture-';

function pageSeed(stage, prefix) {
  const result = { stage, applied: [], waiting: [] };
  if (stage === 'prepare') {
    // Marks first-run setup done. The screens read the flag at start, so they reload once, after this answers. When the
    // flag is already set the screens have read it, and a reload would send an open Browser or Plan Queue screen back
    // to the start, so a repeat run leaves the page where it is.
    if (localStorage.getItem('aiorch.setup.completed') !== '1') {
      localStorage.setItem('aiorch.setup.completed', '1');
      setTimeout(() => location.replace(location.origin + '/'), 50);
      result.applied.push('first-run setup marked done');
    }
    return JSON.stringify(result);
  }
  const ng = window.ng;
  if (!ng || typeof ng.getComponent !== 'function') {
    result.error = 'these screens were not built for development (no window.ng), so they cannot be filled in';
    return JSON.stringify(result);
  }
  const seeded = window.__aioFixtures || (window.__aioFixtures = new WeakSet());
  const marks = window.__aioFixtureMarks || (window.__aioFixtureMarks = {});

  const roleChoice = document.querySelector('app-role-choice');
  if (roleChoice) {
    const button = Array.from(roleChoice.querySelectorAll('button')).find(candidate => /main harness/i.test(candidate.textContent || ''));
    if (button) {
      button.click();
      result.applied.push('role choice: main Harness');
    }
  }

  const components = [];
  for (const element of document.querySelectorAll('*')) {
    let component = null;
    try { component = ng.getComponent(element); } catch (error) { component = null; }
    if (component) components.push(component);
  }
  const findService = (test) => {
    for (const component of components) {
      for (const key of Object.keys(component)) {
        const value = component[key];
        if (value && typeof value === 'object' && test(value)) return value;
      }
    }
    return null;
  };
  const screen = (selector) => {
    const element = document.querySelector(selector);
    return element ? ng.getComponent(element) : null;
  };
  const tag = (label) => `${label} (test fixture)`;
  const once = (key, apply) => {
    if (marks[key]) return;
    apply();
    marks[key] = true;
    result.applied.push(key);
  };

  const cliStore = findService(value => typeof value.noClisError === 'function' && value.state && typeof value.state.update === 'function');
  if (cliStore) {
    once('AI tools shown as installed', () => cliStore.state.update(state => ({
      ...state,
      clis: ['claude', 'codex', 'gemini'].map(name => ({ name, command: name, displayName: name, installed: true, version: 'fixture' })),
      selectedCli: 'claude', loading: false, initialized: true,
    })));
  } else {
    result.waiting.push('AI tool list');
  }

  const instanceStore = findService(value => typeof value.addInstanceFromData === 'function' && typeof value.setSelectedInstance === 'function');
  // A signal is a function carrying set and update.
  const queueOwner = instanceStore && instanceStore.stateService && typeof instanceStore.stateService.messageQueue === 'function'
    && typeof instanceStore.stateService.messageQueue.update === 'function' ? instanceStore.stateService : null;
  if (instanceStore && queueOwner) {
    once('two sessions with queued messages', () => {
      const now = Date.now();
      const session = (id, name, status) => ({
        id: prefix + id, displayName: tag(name), createdAt: now, historyThreadId: prefix + id, parentId: null, childrenIds: [],
        agentId: 'build', agentMode: 'build', provider: 'claude', status, contextUsage: { used: 0, total: 200000, percentage: 0 },
        lastActivity: now, providerSessionId: prefix + id, sessionId: prefix + id, restartEpoch: 0, workingDirectory: '.',
        outputBuffer: [], executionLocation: { type: 'local' },
      });
      instanceStore.addInstanceFromData(session('idle', 'Idle session', 'idle'));
      instanceStore.addInstanceFromData(session('busy', 'Busy session', 'busy'));
      queueOwner.messageQueue.update((queues) => {
        const next = new Map(queues);
        next.set(prefix + 'busy', [
          { message: 'Queued message one (test fixture)', kind: 'queue' },
          { message: 'Steering message (test fixture)', kind: 'steer' },
        ]);
        return next;
      });
      instanceStore.setSelectedInstance(prefix + 'busy');
    });
  } else {
    result.waiting.push('session list');
  }

  const browserPage = screen('app-browser-page');
  if (browserPage && !seeded.has(browserPage)) {
    const now = Date.now();
    browserPage.profiles.set([{
      id: prefix + 'profile', label: tag('Browser profile'), mode: 'isolated', browser: 'chrome', allowedOrigins: [],
      status: 'running', createdAt: now, updatedAt: now,
    }]);
    browserPage.targets.set([{
      id: prefix + 'target', profileId: prefix + 'profile', mode: 'isolated', driver: 'cdp', status: 'available',
      title: tag('Browser page'), url: 'https://example.invalid/', origin: 'https://example.invalid', lastSeenAt: now,
    }]);
    browserPage.selectedProfileId.set(prefix + 'profile');
    browserPage.selectedTargetId.set(prefix + 'target');
    seeded.add(browserPage);
    result.applied.push('Browser profile and page');
  } else if (!browserPage) {
    result.waiting.push('open the Browser screen for its fixtures');
  }

  const accountRules = screen('app-plan-queue-account-rules-panel');
  if (accountRules && !seeded.has(accountRules)) {
    // One account that is turned off but named by a rule, and a rule naming an account that no longer exists.
    accountRules.pooledAccounts.set([{ id: prefix + 'off', provider: 'claude', label: tag('Turned-off account'), enabled: false }]);
    accountRules.pooledLoaded.set(true);
    accountRules.entries.set(new Map([
      ['claude:' + prefix + 'off', { ref: { provider: 'claude', accountId: prefix + 'off' }, choice: 'never' }],
      ['claude:' + prefix + 'gone', { ref: { provider: 'claude', accountId: prefix + 'gone' }, choice: 'last' }],
    ]));
    seeded.add(accountRules);
    result.applied.push('unavailable accounts in the Plan Queue account rules');
  } else if (!accountRules) {
    result.waiting.push('open Plan Queue account rules for their fixtures');
  }
  return JSON.stringify(result);
}

/** The source text to evaluate in the copy's window for one stage: `prepare`, or `fill` (safe to repeat). */
function seedExpression(stage) {
  if (!['prepare', 'fill'].includes(stage)) throw new Error('unknown seed stage');
  return `(${pageSeed.toString()})(${JSON.stringify(stage)}, ${JSON.stringify(FIXTURE_PREFIX)})`;
}

module.exports = { FIXTURE_PREFIX, pageSeed, seedExpression };
