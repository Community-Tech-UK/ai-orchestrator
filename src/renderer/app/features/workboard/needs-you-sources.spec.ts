import { describe, expect, it } from 'vitest';
import { NEEDS_YOU_RECENCY_MS, type NeedsYouEntry } from '../../../../shared/attention/needs-you';
import { needsYouReason, requestEntries, workboardEntry } from './needs-you-sources';
import type { NeedsYouSources } from './needs-you-sources';

const now = 30 * 86400_000;
const entry = (source: NeedsYouEntry['source'], extra: Partial<NeedsYouEntry> = {}): NeedsYouEntry =>
  ({ key: `${source}:x`, source, kind: 'answer', title: 'Session title', since: 1, version: '1', instanceId: 'i', ...extra });
const empty = (): NeedsYouSources => ({ permissions: [], browsers: [], fallbacks: [], plans: [], documents: [], memories: [], sidechats: [], outstanding: [], toolLoops: [] });

describe('needs-you source mapping', () => {
  it('excludes old document reviews, answered questions and all 293 pre-B5 rows', () => {
    const sources = empty();
    sources.documents = [
      { id: 'old', title: 'old', status: 'pending', createdAt: now - NEEDS_YOU_RECENCY_MS - 1 },
      { id: 'fresh', title: 'fresh', status: 'pending', createdAt: now - 1 },
    ];
    sources.outstanding = Array.from({ length: 293 }, (_, index) => ({
      id: String(index), kind: 'needs-human', status: 'open', firstSeenRound: null, riskClass: null,
      userResponse: null, text: 'legacy', createdAt: 1, updatedAt: now - 17 * 86400_000, chatId: 'a',
    }));
    expect(requestEntries(sources, now).map((item) => item.key)).toEqual(['doc-review:fresh']);
  });
  it('maps deadlines, groups plan documents, excludes unread sidechats and uses B5 applied rules', () => {
    const sources = empty();
    sources.permissions = [{ id: 'p', instanceId: 'a', description: 'Allow tool', createdAt: 1, expiresAt: now + 100 }];
    sources.browsers = [{ requestId: 'b', instanceId: 'a', createdAt: 2, expiresAt: now + 200 }];
    sources.fallbacks = [{ id: 'f', slot: 'summary', createdAt: 3, expiresAt: now + 300 }];
    sources.plans = [1, 2].map((id) => ({ id: String(id), sourceRef: '/plan/foo_plan.md', updatedAt: 4 }));
    sources.memories = [{ id: 'm', title: 'Memory', status: 'pending', createdAt: 5 }];
    sources.sidechats = [{ parent: { kind: 'chat', chatId: 'c' }, parentTitle: 'Parent', needsAttention: 0, attentionSince: null },
      { parent: { kind: 'chat', chatId: 'd' }, parentTitle: 'Other', needsAttention: 1, attentionSince: 50 }];
    sources.outstanding = [{ id: 'o', kind: 'decision-applied', status: 'open', riskClass: null, firstSeenRound: 1, userResponse: null, text: 'Choice', createdAt: 6, updatedAt: 6, chatId: 'a' }];
    sources.toolLoops = [{ instanceId: 't', detector: 'repeat-no-progress', toolName: 'Bash', count: 12, detectedAt: 7, sessionName: 'Fix login' }];
    const result = requestEntries(sources, now);
    expect(result).toHaveLength(8);
    // A possibly stuck session says what is asked and what it has been doing, not just a tool name.
    expect(result.find((item) => item.source === 'tool-loop')).toMatchObject({
      title: 'Fix login may be stuck: stop it or let it continue',
      detail: 'It has run Bash 12 times in a row and got the same result each time.',
      instanceId: 't',
    });
    expect(result.find((item) => item.source === 'browser-approval')?.deadlineAt).toBe(now + 200);
    expect(result.find((item) => item.source === 'plan-queue-question')?.title).toBe('Plan Queue has 2 questions for you');
    expect(result.find((item) => item.source === 'loop-decision')?.kind).toBe('applied');
    expect(result.find((item) => item.source === 'memory-review')?.kind).toBe('check');
  });
  it('says in plain words why a session needs you', () => {
    expect(needsYouReason(entry('session'), 'Needs your OK', { kind: 'permission', toolName: 'Bash', text: 'May I?' })).toBe('Wants permission to use Bash');
    expect(needsYouReason(entry('session'), 'Needs your answer', { kind: 'question', text: 'Which council first?' })).toBe('Asked you: Which council first?');
    expect(needsYouReason(entry('session'), 'Problem — the session hit an error')).toBe('Problem — the session hit an error');
    expect(needsYouReason(entry('session'), undefined, { kind: 'permission', toolName: 'mcp__browser-gateway__browser_navigate', text: '' }))
      .toBe('Wants permission to use browser_navigate (browser-gateway)');
    expect(needsYouReason(entry('session', { kind: 'check' }), 'Problem — x', { kind: 'question', text: '  ' })).toBe('Problem — x');
    // A stopped loop is named in plain words, never by its raw label ("cap", "running").
    expect(needsYouReason(entry('loop-run', { kind: 'check', title: 'Loop title' }))).toBe('Loop stopped with a problem');
    expect(needsYouReason(entry('automation-run'))).toBe('Automation is waiting for you');
    expect(needsYouReason(entry('permission-request', { title: 'Run npm install' }))).toBe('Wants permission: Run npm install');
    expect(needsYouReason(entry('browser-approval'))).toBe('Wants your OK for a browser step');
    expect(needsYouReason(entry('loop-question', { title: 'Waiting for you', detail: 'Ship it?' }))).toBe('Asked you: Ship it?');
    // The session list shows the name beside the reason, so the reason leaves it out.
    expect(needsYouReason(entry('tool-loop', { title: 'Fix login may be stuck: stop it or let it continue' }))).toBe('May be stuck: stop it or let it continue');
  });
  it('maps each correlated Workboard source once', () => {
    for (const kind of ['instance', 'loop-run', 'automation-run', 'repo-job'] as const) {
      const item = { id: `${kind}:a`, primary: { kind }, attentionLevel: 'failed', title: 'Failure', updatedAt: 42, instanceId: 'i' };
      expect(workboardEntry(item as never)).toMatchObject({ source: kind === 'instance' ? 'session' : kind, kind: 'check', instanceId: 'i' });
    }
  });
  it('sorts a sidechat by its real onset: after an older untimed prompt, before newer, behind timed deadlines', async () => {
    const { sortNeedsYou } = await import('../../../../shared/attention/needs-you');
    const sources = empty();
    sources.permissions = [{ id: 'p', instanceId: 'a', description: 'Allow', createdAt: 900, expiresAt: now + 100 }];
    sources.sidechats = [{ parent: { kind: 'chat', chatId: 'd' }, parentTitle: 'Side', needsAttention: 1, attentionSince: 500 }];
    sources.outstanding = [100, 800].map((at) => ({ id: `q${at}`, kind: 'needs-human', status: 'open', riskClass: null, firstSeenRound: 1, userResponse: null, text: 'Q', createdAt: at, updatedAt: at, chatId: 'a' }));
    const entries = requestEntries(sources, now);
    expect(entries.find((e) => e.source === 'sidechat')?.since).toBe(500);
    expect(sortNeedsYou(entries).map((e) => (e.source === 'sidechat' ? 'sidechat' : e.key))).toEqual(['permission-request:p', 'loop-question:q100', 'sidechat', 'loop-question:q800']);
  });
  it('keeps a sidechat entry stable when its attention state is unchanged and renews it for a new episode', () => {
    const sources = empty();
    sources.sidechats = [{ parent: { kind: 'chat', chatId: 'd' }, parentTitle: 'Side', needsAttention: 1, attentionSince: 500 }];
    const first = requestEntries(sources, now)[0];
    expect(requestEntries(sources, now + 60_000)[0]).toEqual(first);
    sources.sidechats = [{ ...sources.sidechats[0], attentionSince: 900 }];
    const reopened = requestEntries(sources, now)[0];
    expect(reopened.key).toBe(first.key);
    expect(reopened.since).toBe(900);
    expect(reopened.version).not.toBe(first.version);
  });
  it('keeps untimed sidechat waits stable so older untimed prompts stay ahead while deadlines still win', async () => {
    const { sortNeedsYou } = await import('../../../../shared/attention/needs-you');
    const sources = empty();
    sources.permissions = [{ id: 'p', instanceId: 'a', description: 'Allow', createdAt: 900, expiresAt: now + 100 }];
    sources.sidechats = [{ parent: { kind: 'chat', chatId: 'd' }, parentTitle: 'Side', needsAttention: 1, attentionSince: null }];
    sources.outstanding = [{ id: 'q-old', kind: 'needs-human', status: 'open', riskClass: null, firstSeenRound: 1, userResponse: null, text: 'Q', createdAt: 100, updatedAt: 100, chatId: 'a' }];
    const firstSidechat = requestEntries(sources, now).find((entry) => entry.source === 'sidechat')!;
    const secondSidechat = requestEntries(sources, now + 60_000).find((entry) => entry.source === 'sidechat')!;
    expect(firstSidechat.since).toBe(Number.MAX_SAFE_INTEGER);
    expect(secondSidechat.since).toBe(firstSidechat.since);
    expect(sortNeedsYou(requestEntries(sources, now)).map((entry) => (entry.source === 'sidechat' ? 'sidechat' : entry.key)))
      .toEqual(['permission-request:p', 'loop-question:q-old', 'sidechat']);
  });
  it('keeps session sidechat ownership stable across node changes and reopened episodes', () => {
    const sources = empty();
    sources.sidechats = [{ parent: { kind: 'session', historyThreadId: 'thread-1', originNodeId: 'node-a' }, parentTitle: 'Session', needsAttention: 1, attentionSince: 500 }];
    const first = requestEntries(sources, now)[0];
    sources.sidechats = [{ parent: { kind: 'session', historyThreadId: 'thread-1', originNodeId: 'node-b' }, parentTitle: 'Session', needsAttention: 0, attentionSince: null }];
    expect(requestEntries(sources, now)).toEqual([]);
    sources.sidechats = [{ parent: { kind: 'session', historyThreadId: 'thread-1', originNodeId: 'node-b' }, parentTitle: 'Session', needsAttention: 1, attentionSince: 900 }];
    const reopened = requestEntries(sources, now)[0];
    expect(reopened.key).toBe(first.key);
    expect(reopened.since).toBe(900);
    expect(reopened.version).not.toBe(first.version);
  });
  it('orders two sidechat parents by their own attention onset timestamps', async () => {
    const { sortNeedsYou } = await import('../../../../shared/attention/needs-you');
    const sources = empty();
    sources.sidechats = [
      { parent: { kind: 'chat', chatId: 'newer' }, parentTitle: 'Newer', needsAttention: 1, attentionSince: 700 },
      { parent: { kind: 'chat', chatId: 'older' }, parentTitle: 'Older', needsAttention: 1, attentionSince: 400 },
    ];
    expect(sortNeedsYou(requestEntries(sources, now)).map((entry) => entry.key))
      .toEqual(['sidechat:chat:older', 'sidechat:chat:newer']);
  });
});
