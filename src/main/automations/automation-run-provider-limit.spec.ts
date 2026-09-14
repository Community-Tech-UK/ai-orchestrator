import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import type { InstanceManager } from '../instance/instance-manager';
import type { AutomationRun } from '../../shared/types/automation.types';
import { AutomationStore } from './automation-store';
import type { AutomationAttachmentService } from './automation-attachment-service';
import { AutomationRunner } from './automation-runner';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { classifyFinalOutputProviderLimit } from './automation-run-provider-limit';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/ai-orchestrator-test') },
  powerMonitor: new EventEmitter(),
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../channels/channel-manager', () => ({
  getChannelManager: () => ({ getAdapter: vi.fn(), emitResponseSent: vi.fn() }),
}));
vi.mock('../session/artifact-attribution-store', () => ({
  getArtifactAttributionStore: () => ({ registerArtifact: vi.fn() }),
}));

const SPEND_LIMIT_NOTICE =
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message"
  + ' · your weekly limit resets 11pm (Europe/London)';

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('classifyFinalOutputProviderLimit', () => {
  it('loads the module fresh and compiles every notice pattern without throwing', async () => {
    vi.resetModules();
    const fresh = await import('./automation-run-provider-limit');
    expect(fresh.classifyFinalOutputProviderLimit('Done, 5 drafts queued.')).toBeNull();
    expect(fresh.classifyFinalOutputProviderLimit("You've hit your session limit · resets 6:30pm (Europe/London)"))
      .toBe("provider_limit: You've hit your session limit · resets 6:30pm (Europe/London)");
  });

  it('classifies real provider limit notices with a provider_limit error', () => {
    expect(classifyFinalOutputProviderLimit(`\n${SPEND_LIMIT_NOTICE}\n`)).toBe(`provider_limit: ${SPEND_LIMIT_NOTICE}`);
    const notices = [
      "You've hit your session limit · resets 6:30pm",
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:01 PM.",
      'Error: You have exceeded your monthly quota (Request ID: <redacted>)',
      'Claude usage limit reached',
      "You've hit your limit · resets 11pm",
      "You've hit your Opus limit · resets 11pm",
      '⚠ 5-hour limit reached ∙ resets 3am',
      'Session limit reached ∙ resets 7pm',
      'Claude AI usage limit reached|1757800000',
      'API Error: Claude usage limit reached. Your limit will reset at 7pm (Europe/London).',
      "You've reached your usage limit.",
      "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 3 days.",
      "You've hit your usage limit. Upgrade to Pro or try again in 2 days.",
      'Opus limit reached ∙ resets 3am',
      'Sonnet limit reached · resets 11pm (Europe/London)',
      "stream error: You've hit your usage limit.",
      "■ You've hit your weekly limit · resets Monday",
      "You've hit your session limit · resets Sep 20 at 5pm",
      "> You've hit your 5-hour limit · resets in 2 hours",
      'Claude usage limit reached.',
      'Session limit reached ∙ resets 7pm (America/New_York)',
      "You've hit your usage limit · resets 3am (UTC+1)",
      "You've hit your weekly limit · resets Monday (GMT+01:00)",
      'Opus limit reached ∙ resets 11pm (BST)',
    ];
    for (const notice of notices) {
      expect(classifyFinalOutputProviderLimit(notice), notice).toBe(`provider_limit: ${notice}`);
    }
  });

  it('never fails genuine output on a lone reset time, too-many-requests or quota phrase', () => {
    const legit = [
      'Done, LinkedIn cap resets 11pm.',
      'Charity API: too many requests, skipped 3.',
      'Quota exceeded on Explee credits; nothing sent.',
      'Added a rate limit to the API.',
      'Outreach paused: LinkedIn message limit reached for today.',
      "Done. You've hit your LinkedIn search limit, 3 profiles stored.",
      'Google Ads spend limit hit on 2 campaigns; budget resets 9am tomorrow.',
      'Checked Explee: daily quota exceeded, spend limit unchanged.',
      "Claude drafted 4 emails. You've hit your daily send cap in Krystal.",
      'Weekly LinkedIn limit · resets Monday.',
      'Codex review done. Weekly LinkedIn limit · resets Monday.',
      'Claude drafted 3 replies; Explee usage limit reached, no sends.',
      'Checked copilot seats: usage limit reached on 2 seats.',
      'Summary: you have hit your usage limit for Mailchimp sends this month; Claude drafted the rest.',
      'Note: Claude API session limit reached in the scraper helper once, retried OK.',
      'OpenAI embeddings usage limit reached for the site-audit worker, 3 audits deferred.',
      'Codex ran the Explee bulk usage limit reached check, all clear.',
      "Harness report: Codex usage limit reached on 2 runs yesterday; today's desk ran clean, 5 drafts.",
      "Watchdog: last night's run said 'Claude usage limit reached', today green. 0 actions.",
      'Copilot usage limit reached for seat james; renewal booked. Inbox clear.',
      "Explee: You've hit your monthly usage limit · resets 1 Oct. Enrichment skipped.",
      "Explee API 429: You've hit your usage limit. Visit https://app.explee.com/settings/usage.",
      "You've hit your weekly limit · resets Monday for LinkedIn invitations.",
      'Error: Session limit reached ∙ resets when the browser worker restarts; 0 sends.',
      "You've hit your spend limit. Try again after topping up Google Ads.",
      'Weekly limit reached.',
      '- Weekly limit reached.',
      'Weekly limit reached|20',
      "You've hit your session limit · resets 6:30pm\nThen I drafted 5 replies and queued them for review.",
      "... You've hit your usage limit · resets 3am",
      'Claude Opus 4 limit reached, now using Sonnet 4',
      'Weekly limit reached · resets Monday (LinkedIn)',
      '5-hour limit reached ∙ resets 3am (Explee)',
      `Outreach desk finished. ${'Details. '.repeat(60)} You've hit your session limit · resets 6:30pm`,
    ];
    for (const text of legit) {
      expect(classifyFinalOutputProviderLimit(text), text).toBeNull();
    }
    expect(classifyFinalOutputProviderLimit(undefined)).toBeNull();
  });
});

describe('AutomationRunner final-output provider-limit detection', () => {
  let db: SqliteDriver;
  let store: AutomationStore;
  let manager: InstanceManager & EventEmitter;
  let retries: { nextAttempt: number; delayMs: number }[];

  beforeEach(() => {
    resetAutomationEventsForTesting();
    db = createDb();
    store = new AutomationStore(db, {
      prepare: async () => [],
      replacePrepared: () => undefined,
      listForAutomation: async () => [],
    } as unknown as AutomationAttachmentService, 5);
    retries = [];
    manager = Object.assign(new EventEmitter(), {
      createInstance: vi.fn(async () => ({ id: 'instance-1', outputBuffer: [], status: 'busy' })),
      getInstance: vi.fn(() => undefined),
    }) as unknown as InstanceManager & EventEmitter;
  });

  afterEach(() => {
    db.close();
  });

  async function createAutomation(): Promise<string> {
    const automation = await store.create({
      name: 'Morning desk',
      schedule: { type: 'cron', expression: '0 8 * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      action: { prompt: 'Do work', workingDirectory: '/tmp', provider: 'claude', model: 'opus' },
    }, 1_000, 100);
    return automation.id;
  }

  async function runWithOutputs(
    outputs: string[],
    maxAttempts: number,
    existingAutomationId?: string,
  ): Promise<{ run: AutomationRun; automationId: string }> {
    const automationId = existingAutomationId ?? await createAutomation();
    manager.removeAllListeners();
    const runner = new AutomationRunner(
      store,
      getAutomationEvents(),
      () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }),
      maxAttempts,
      100,
      () => ({ automationDefaultCli: 'auto', automationDefaultModel: '', modelPickerFavorites: [] }),
    );
    runner.setRetryScheduler((_run, nextAttempt, _max, delayMs) => retries.push({ nextAttempt, delayMs }));
    runner.initialize(manager);

    const outcome = await runner.fire(automationId, { trigger: 'manual' });
    expect(outcome.status).toBe('started');
    for (const content of outputs) {
      manager.emit('provider:normalized-event', {
        instanceId: 'instance-1',
        event: { kind: 'output', messageType: 'assistant', content },
      });
    }
    manager.emit('provider:normalized-event', { instanceId: 'instance-1', event: { kind: 'complete' } });

    const runs = store.listRuns({ automationId });
    return { run: runs[0]!, automationId };
  }

  it('records a spend-limit final output as failed without growing the streak', async () => {
    const { run, automationId } = await runWithOutputs(['Checked the inbox, 3 items.', SPEND_LIMIT_NOTICE], 1);

    expect(run.status).toBe('failed');
    expect(run.error).toBe(`provider_limit: ${SPEND_LIMIT_NOTICE}`);
    expect(run.outputSummary).toBe(SPEND_LIMIT_NOTICE);
    const automation = await store.get(automationId);
    expect(automation?.consecutiveFailures).toBe(0);
    expect(automation?.lastFailureReason).toBe(`provider_limit: ${SPEND_LIMIT_NOTICE}`);
    expect(automation?.lastFailureAt).toEqual(expect.any(Number));
  });

  it('arms no retry for a provider-limit failure even when the retry policy allows retries', async () => {
    const { run } = await runWithOutputs([SPEND_LIMIT_NOTICE], 3);

    expect(run.status).toBe('failed');
    expect(run.maxAttempts).toBe(3);
    expect(retries).toHaveLength(0);
    expect(store.listPendingRetries()).toHaveLength(0);
  });

  it('leaves the automation enabled with its streak unchanged after 6 consecutive provider-limit failures', async () => {
    const automationId = await createAutomation();
    for (let i = 0; i < 6; i += 1) {
      const { run } = await runWithOutputs([SPEND_LIMIT_NOTICE], 1, automationId);
      expect(run.status).toBe('failed');
    }

    const automation = await store.get(automationId);
    expect(store.listRuns({ automationId }).filter((r) => r.status === 'failed')).toHaveLength(6);
    expect(automation?.enabled).toBe(true);
    expect(automation?.consecutiveFailures).toBe(0);
  });

  it('keeps a normal run that merely mentions a limit as succeeded', async () => {
    const { run, automationId } = await runWithOutputs(['Added a rate limit to the API; the daily quota dashboard is done.'], 1);

    expect(run.status).toBe('succeeded');
    expect(run.error).toBeNull();
    expect((await store.get(automationId))?.consecutiveFailures).toBe(0);
  });

  it('keeps a run that hit a limit notice mid-run and then completed as succeeded', async () => {
    const { run } = await runWithOutputs([SPEND_LIMIT_NOTICE, 'Resumed and finished: 4 drafts queued for review.'], 1);

    expect(run.status).toBe('succeeded');
    expect(run.outputSummary).toBe('Resumed and finished: 4 drafts queued for review.');
    expect(retries).toHaveLength(0);
  });
});
