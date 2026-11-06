import { beforeEach, describe, expect, it, vi } from 'vitest';

const logInfo = vi.hoisted(() => vi.fn());

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: logInfo,
    warn: vi.fn(),
  }),
}));

import type { Instance } from '../../shared/types/instance.types';
import { findVolatileText } from '../context/prompt-injection-contract';
import {
  parseOrchestratorCommands,
  ORCHESTRATION_MARKER_START,
} from './orchestration-protocol';
import { buildActiveGoalContext } from '../commands/goal-command';
import { buildReplayContinuityMessage } from '../session/replay-continuity';
import {
  CONSENSUS_RULES,
  HARNESS_GUIDE,
  SCHEDULING_RULES_REPEAT_LINE,
  CONSENSUS_RULES_REPEAT_LINE,
  buildSchedulingRules,
} from './orchestration-protocol.prompts';
import {
  getHarnessGuidance,
  selectHarnessGuidance,
  shouldReceiveHarnessGuide,
  startsWithHarnessContext,
  startsWithHarnessGuidance,
  stripLeadingHarnessContext,
  stripLeadingHarnessGuidance,
  textForIntentMatching,
} from './harness-guidance';

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst_test',
    providerSessionId: 'provider-session-1',
    depth: 0,
    ...overrides,
  } as Instance;
}

describe('HARNESS_GUIDE', () => {
  it('keeps the Harness guide under 1,600 characters with no volatile text', () => {
    expect(HARNESS_GUIDE.length).toBeLessThan(1_600);
    expect(findVolatileText(HARNESS_GUIDE)).toEqual([]);
    expect(findVolatileText(CONSENSUS_RULES)).toEqual([]);
  });

  it('every marker example in the guide and both rule sets parses with the real command parser', () => {
    const rules = buildSchedulingRules(new Date('2026-10-10T15:42:00Z'), 'Europe/London');
    for (const [text, action] of [
      [HARNESS_GUIDE, 'spawn_child'],
      [rules, 'create_automation'],
      [CONSENSUS_RULES, 'consensus_query'],
    ] as const) {
      const commands = parseOrchestratorCommands(text);
      expect(commands).toHaveLength(1);
      expect(commands[0]?.action).toBe(action);
    }
  });

  it('steers scheduling to create_automation and names the host scheduler as the thing to avoid', () => {
    const rules = buildSchedulingRules(new Date('2026-10-10T15:42:00Z'), 'Europe/London');
    expect(rules).toContain('create_automation');
    expect(rules).toMatch(/CLI's own scheduler/);
    expect(rules).toMatch(/the user cannot manage them in Harness/);
    expect(rules).toMatch(/It runs on this machine|run without this machine's browser/);
  });

  it('keeps the scheduling rules conditional and carries the compact skeleton', () => {
    const rules = buildSchedulingRules(new Date('2026-10-10T15:42:00Z'), 'Europe/London');
    expect(rules).toMatch(/If it does/);
    expect(rules).toMatch(/only mentioned in passing[\s\S]*continue with the task/i);
    expect(rules).toContain(ORCHESTRATION_MARKER_START);
    expect(rules).toContain('"action":"create_automation"');
  });

  it('keeps the consensus rules conditional and evidence-led', () => {
    expect(CONSENSUS_RULES).toMatch(/If so/);
    expect(CONSENSUS_RULES).toMatch(/continue without it/);
    expect(CONSENSUS_RULES).toMatch(/agreement[\s\S]*dissent[\s\S]*provider failures/i);
    expect(CONSENSUS_RULES).toContain('"action":"consensus_query"');
  });

  it('fills the local-time line in the scheduling rules at send time', () => {
    const rules = buildSchedulingRules(new Date('2026-10-10T15:42:00Z'), 'UTC');
    expect(rules).toContain('Local time now: 2026-10-10T15:42 (UTC).');
    expect(HARNESS_GUIDE).not.toContain('Local time now');
  });

  it('carries the helper-batching sentence from Step 13c', () => {
    expect(HARNESS_GUIDE).toContain(
      'When you start several helpers together, Harness tells you once, after the last one finishes (or after 10 minutes). You do not need to poll.',
    );
  });
});

describe('textForIntentMatching', () => {
  it('returns empty for a slash command', () => {
    expect(textForIntentMatching('/schedule nightly build')).toBe('');
    expect(textForIntentMatching('  /compact')).toBe('');
  });

  it('removes fenced blocks, including an unterminated one to the end', () => {
    expect(textForIntentMatching('```\ncron: daily\n```\nwhy does this fail?')).not.toContain('daily');
    expect(textForIntentMatching('```\ncron: daily')).not.toContain('daily');
  });

  it('removes inline code, quoted lines and log-like lines', () => {
    expect(textForIntentMatching('look at `daily` and decide')).not.toContain('daily');
    expect(textForIntentMatching('> remind me tomorrow')).not.toContain('tomorrow');
    expect(
      textForIntentMatching('2026-10-10T09:00:01Z INFO daily job started\nwhy is this slow?'),
    ).not.toContain('daily');
    expect(textForIntentMatching('{"level":"info","msg":"daily"}\nwhy is this slow?')).not.toContain('daily');
  });

  it('removes path and file tokens', () => {
    expect(
      textForIntentMatching('fix the bug in src/main/automations/automation-runner.ts'),
    ).not.toContain('automations');
    expect(textForIntentMatching('read notes.md and continue')).not.toContain('notes.md');
  });

  it('keeps ordinary prose', () => {
    expect(textForIntentMatching('Set up a daily check of CI at 9am')).toContain('daily');
  });
});

describe('selectHarnessGuidance corpus', () => {
  const now = new Date('2026-10-10T15:42:00Z');
  const zone = 'UTC';
  const delivered = new Set<'scheduling' | 'consensus'>();

  it.each([
    ['Set up a daily check of CI at 9am', 'scheduling'],
    ['Can you get a second opinion on whether this migration is safe?', 'consensus'],
    ['What does consensus_query do?', null],
    ['/schedule nightly build', null],
    ['```\ncron: daily\n```\nwhy does this fail?', null],
    ['> remind me tomorrow', null],
    ['2026-10-10T09:00:01Z INFO daily job started\nwhy is this slow?', null],
    ['fix the bug in src/main/automations/automation-runner.ts', null],
  ])('selects guidance for %j', (message, expected) => {
    const result = selectHarnessGuidance(message, delivered, now, zone);
    if (expected === null) {
      expect(result.text).toBeNull();
      expect(result.added).toEqual([]);
    } else {
      expect(result.added).toEqual([expected]);
    }
  });

  it('puts scheduling before consensus when both match', () => {
    const result = selectHarnessGuidance(
      'Schedule this daily, but first run a consensus check on the risky decision',
      delivered,
      now,
      zone,
    );
    expect(result.added).toEqual(['scheduling', 'consensus']);
    expect(result.text?.indexOf('## Harness scheduling rules')).toBeLessThan(
      result.text?.indexOf('## Harness consensus rules') ?? -1,
    );
  });

  it('gives the one-line repeat for a section already delivered', () => {
    const result = selectHarnessGuidance(
      'Please set up a daily CI check again',
      new Set(['scheduling']),
      now,
      zone,
    );
    expect(result.text).toBe(SCHEDULING_RULES_REPEAT_LINE);
    expect(result.added).toEqual([]);
    expect(result.repeated).toEqual(['scheduling']);
    const consensusRepeat = selectHarnessGuidance(
      'Run a consensus check on this again',
      new Set(['consensus']),
      now,
      zone,
    );
    expect(consensusRepeat.text).toBe(CONSENSUS_RULES_REPEAT_LINE);
    expect(consensusRepeat.repeated).toEqual(['consensus']);
  });
});

describe('HarnessGuidance latch', () => {
  beforeEach(() => {
    getHarnessGuidance()._resetForTesting();
    logInfo.mockClear();
  });

  it('adds a section once per provider session, then the one-line repeat', () => {
    const instance = makeInstance();
    const first = getHarnessGuidance().takeHarnessGuidance(
      instance,
      'Set up a daily check of CI at 9am',
      'later-turn',
    );
    expect(first.text).toContain('## Harness scheduling rules');
    first.commit();

    const second = getHarnessGuidance().takeHarnessGuidance(
      instance,
      'Please schedule a daily CI check',
      'later-turn',
    );
    expect(second.text).toBe(SCHEDULING_RULES_REPEAT_LINE);
  });

  it('treats a new providerSessionId as a new conversation', () => {
    const instance = makeInstance();
    const first = getHarnessGuidance().takeHarnessGuidance(
      instance,
      'Set up a daily check of CI at 9am',
      'later-turn',
    );
    first.commit();

    instance.providerSessionId = 'provider-session-2';
    const afterRestart = getHarnessGuidance().takeHarnessGuidance(
      instance,
      'Set up a daily check of CI at 9am',
      'later-turn',
    );
    expect(afterRestart.text).toContain('## Harness scheduling rules');
  });

  it('adoptProviderSessionId keeps the latch for the same conversation', () => {
    const instance = makeInstance();
    const first = getHarnessGuidance().takeHarnessGuidance(
      instance,
      'Set up a daily check of CI at 9am',
      'first-message',
    );
    first.commit();

    getHarnessGuidance().adoptProviderSessionId(
      instance,
      'provider-session-1',
      'provider-session-adopted',
    );
    instance.providerSessionId = 'provider-session-adopted';
    const second = getHarnessGuidance().takeHarnessGuidance(
      instance,
      'Set up a daily check of CI at 9am',
      'later-turn',
    );
    expect(second.text).toBe(SCHEDULING_RULES_REPEAT_LINE);
  });

  it('does not mark the latch without commit', () => {
    const instance = makeInstance();
    const first = getHarnessGuidance().takeHarnessGuidance(
      instance,
      'Set up a daily check of CI at 9am',
      'later-turn',
    );
    expect(first.text).toContain('## Harness scheduling rules');
    // no commit() — simulating a failed send
    const second = getHarnessGuidance().takeHarnessGuidance(
      instance,
      'Set up a daily check of CI at 9am',
      'later-turn',
    );
    expect(second.text).toContain('## Harness scheduling rules');
  });

  it('returns null text and a no-op commit for a message with no match', () => {
    const instance = makeInstance();
    const handle = getHarnessGuidance().takeHarnessGuidance(
      instance,
      'fix the failing test',
      'later-turn',
    );
    expect(handle.text).toBeNull();
    expect(() => handle.commit()).not.toThrow();
  });
});

describe('"Harness guidance added" log', () => {
  const added = () => logInfo.mock.calls.filter(([message]) => message === 'Harness guidance added');

  beforeEach(() => {
    getHarnessGuidance()._resetForTesting();
    logInfo.mockClear();
  });

  it('logs once per addition, when it is delivered, with path and sections', () => {
    const handle = getHarnessGuidance().takeHarnessGuidance(
      makeInstance(),
      'Set up a daily check of CI at 9am',
      'first-message',
    );
    expect(added()).toHaveLength(0);
    handle.commit();
    handle.commit();
    expect(added()).toHaveLength(1);
    expect(added()[0]?.[1]).toMatchObject({
      instanceId: 'inst_test',
      path: 'first-message',
      added: ['scheduling'],
      repeated: [],
      chars: handle.text?.length,
    });
  });

  it('does not log again when the same message is selected again after a failed send', () => {
    const instance = makeInstance();
    const message = 'Set up a daily check of CI at 9am';
    getHarnessGuidance().takeHarnessGuidance(instance, message, 'later-turn'); // send failed: never committed
    const retry = getHarnessGuidance().takeHarnessGuidance(instance, message, 'later-turn');
    expect(added()).toHaveLength(0);
    retry.commit();
    expect(added()).toHaveLength(1);
  });

  it('logs the one-line repeat as its own addition and never for a message with no match', () => {
    const instance = makeInstance();
    getHarnessGuidance().takeHarnessGuidance(instance, 'Set up a daily check of CI at 9am', 'later-turn').commit();
    getHarnessGuidance().takeHarnessGuidance(instance, 'Also schedule a nightly build', 'later-turn').commit();
    getHarnessGuidance().takeHarnessGuidance(instance, 'fix the failing test', 'later-turn').commit();
    expect(added()).toHaveLength(2);
    expect(added()[1]?.[1]).toMatchObject({ added: [], repeated: ['scheduling'] });
  });
});

describe('leading guidance matcher', () => {
  const typed = "Every weekday at 9am, check this repo's CI and tell me what failed.";
  const scheduling = (now: string, zone: string) => buildSchedulingRules(new Date(now), zone);

  it('strips what takeHarnessGuidance really adds, whatever the local time or zone', () => {
    for (const [now, zone] of [
      ['2026-10-10T15:42:00Z', 'Europe/London'],
      ['2027-01-02T03:04:00Z', 'UTC'],
      ['2026-06-30T23:59:00Z', 'Pacific/Auckland'],
    ] as const) {
      const text = scheduling(now, zone);
      expect(stripLeadingHarnessGuidance(`${text}\n\n${typed}`)).toBe(typed);
      expect(startsWithHarnessGuidance(`${text}\n\n${typed}`)).toBe(true);
    }
    const handle = getHarnessGuidance().takeHarnessGuidance(makeInstance(), typed, 'first-message');
    expect(handle.text).toContain('## Harness scheduling rules');
    expect(stripLeadingHarnessGuidance(`${handle.text}\n\n${typed}`)).toBe(typed);
  });

  it('strips scheduling then consensus, and the one-line repeats', () => {
    const both = selectHarnessGuidance(
      'Schedule a daily check and get a second opinion on whether this migration is safe',
      new Set(),
      new Date('2026-10-10T15:42:00Z'),
      'UTC',
    );
    expect(both.added).toEqual(['scheduling', 'consensus']);
    expect(stripLeadingHarnessGuidance(`${both.text}\n\n${typed}`)).toBe(typed);
    expect(stripLeadingHarnessGuidance(`${SCHEDULING_RULES_REPEAT_LINE}\n\n${typed}`)).toBe(typed);
    expect(stripLeadingHarnessGuidance(`${CONSENSUS_RULES_REPEAT_LINE}\n\n${typed}`)).toBe(typed);
    expect(
      stripLeadingHarnessGuidance(`${SCHEDULING_RULES_REPEAT_LINE}\n\n${CONSENSUS_RULES}\n\n${typed}`),
    ).toBe(typed);
    expect(stripLeadingHarnessGuidance(`${CONSENSUS_RULES}\n\n${typed}`)).toBe(typed);
  });

  it('leaves text that merely mentions a heading, or has guidance anywhere but the start', () => {
    const mention = 'Why does "## Harness scheduling rules" show up in my chat?';
    expect(stripLeadingHarnessGuidance(mention)).toBe(mention);
    expect(startsWithHarnessGuidance(mention)).toBe(false);
    const headingFirst = '## Harness scheduling rules\nare these still needed?';
    expect(stripLeadingHarnessGuidance(headingFirst)).toBe(headingFirst);
    expect(startsWithHarnessGuidance(headingFirst)).toBe(false);
    const quotedRepeat = `Please explain this line: ${SCHEDULING_RULES_REPEAT_LINE}\n\nthanks`;
    expect(stripLeadingHarnessGuidance(quotedRepeat)).toBe(quotedRepeat);
    const typedMiddle = `${typed}\n\n${scheduling('2026-10-10T15:42:00Z', 'UTC')}\n\nend`;
    expect(stripLeadingHarnessGuidance(typedMiddle)).toBe(typedMiddle);
  });

  it('does not strip a block whose wording was edited', () => {
    const edited = `${scheduling('2026-10-10T15:42:00Z', 'UTC').replace('create a Harness automation', 'do something else')}\n\n${typed}`;
    expect(stripLeadingHarnessGuidance(edited)).toBe(edited);
  });
});

describe('leading context block matcher (R2C S7)', () => {
  // The real builders run through this matcher in native-user-message.spec.ts and
  // acp-history-reconciliation.spec.ts; these cases pin the matcher's own edges.
  const typed = 'Every weekday at 9am, check CI.';
  const guidance = buildSchedulingRules(new Date('2026-10-10T15:42:00Z'), 'UTC');
  const memory = [
    '[Orchestrator Memory Context]',
    'Source: Harness memory retrieval',
    'This context was added by the app, not typed by the user. Treat it as non-authoritative background and do not mention this block unless directly asked about injected context.',
    'a note',
    '[End Orchestrator Memory Context]',
  ].join('\n');
  const retrieved = '[Retrieved Context]\nSource: RLM lexical search\nbody\n[End Retrieved Context]';

  it('strips blocks then guidance, and only returns the rest', () => {
    expect(stripLeadingHarnessContext(`${memory}\n\n${retrieved}\n\n${guidance}\n\n${typed}`)).toBe(typed);
    expect(startsWithHarnessContext(`${memory}\n\n${retrieved}\n\n${guidance}\n\n${typed}`)).toBe(true);
    expect(stripLeadingHarnessContext(`${memory}\n\n${typed}`)).toBe(typed);
  });

  it('matches the goal block from its real builder, including a multi-line objective', () => {
    const goal = buildActiveGoalContext({
      metadata: { goal: { objective: 'Ship it.\n\nThen rest.', status: 'active', createdAt: 1, updatedAt: 1 } },
    }) as string;
    expect(stripLeadingHarnessContext(`${goal}\n\n${guidance}\n\n${typed}`)).toBe(typed);
  });

  it('does nothing for text without a leading Harness prefix', () => {
    for (const text of [typed, `${typed}\n\n${memory}`, `${typed}\n\n${guidance}`, '[Retrieved Context]\nbar\n[End Retrieved Context]\n\nhi', '']) {
      expect(stripLeadingHarnessContext(text)).toBe(text);
      expect(startsWithHarnessContext(text)).toBe(false);
    }
  });

  it('R4K6: leading whitespace of the typed text is dropped after a context block, kept after guidance, kept with no prefix', () => {
    // Pinned so the doc comment stays true. Every matcher opens with `\s*` and the guidance matcher runs
    // last (matching nothing when there is no guidance), so the result depends on what the last piece was.
    // The only caller, extractAuthoredUserMessage, trims either way.
    const padded = `  \n\t${typed}`;
    expect(stripLeadingHarnessContext(`${memory}\n\n${padded}`)).toBe(typed);
    expect(stripLeadingHarnessContext(`ultrathink\n\n${memory}\n\n${padded}`)).toBe(typed);
    expect(stripLeadingHarnessContext(`${memory}\n\n${guidance}\n\n${padded}`)).toBe(padded);
    // Trailing whitespace is part of what was typed and always stays.
    expect(stripLeadingHarnessContext(`${memory}\n\n${typed}  \n`)).toBe(`${typed}  \n`);
    // No Harness prefix at all: returned untouched, leading whitespace included.
    expect(stripLeadingHarnessContext(padded)).toBe(padded);
    // The caller's trim (extractAuthoredUserMessage) makes the shapes agree.
    expect(stripLeadingHarnessContext(`${memory}\n\n${padded}`).trim()).toBe(typed);
    expect(stripLeadingHarnessContext(`${memory}\n\n${guidance}\n\n${padded}`).trim()).toBe(typed);
  });

  it('does not reach past a block that is out of order', () => {
    const goal = buildActiveGoalContext({
      metadata: { goal: { objective: 'Ship it.', status: 'active', createdAt: 1, updatedAt: 1 } },
    }) as string;
    // The goal block comes after the retrieved blocks in a set, so a block behind it is not Harness's.
    expect(stripLeadingHarnessContext(`${goal}\n\n${memory}\n\n${typed}`)).toBe(`${memory}\n\n${typed}`);
    // R3J4: retrieved then memory is NOT out of order any more. It is what the continuity queue composes
    // when an earlier retrieved-only set is queued ahead of a current memory-only set.
    expect(stripLeadingHarnessContext(`${retrieved}\n\n${memory}\n\n${typed}`)).toBe(typed);
    // A third set is still left alone.
    expect(stripLeadingHarnessContext(`${retrieved}\n\n${memory}\n\n${memory}\n\n${typed}`)).toBe(`${memory}\n\n${typed}`);
  });

  it('stays fast on a long near-miss body', () => {
    const started = Date.now();
    const text = `[Retrieved Context]\nSource: RLM semantic search\n${'x\n'.repeat(200_000)}`;
    expect(stripLeadingHarnessContext(text)).toBe(text);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

// R3J4. The continuity input queue puts a queued earlier set (and a context warning) in
// front of the current set, and plan mode puts `ultrathink` in front of everything. The
// pieces here are the builders' real shapes; the full real composition (the queue's own
// `prepare()` and the real send path) is driven in native-user-message.spec.ts.
describe('leading Harness prefix with a queued earlier set (R3J4)', () => {
  const typed = 'fix those issues please';
  const guidance = buildSchedulingRules(new Date('2026-10-10T15:42:00Z'), 'UTC');
  const memory = [
    '[Orchestrator Memory Context]',
    'Source: Harness memory retrieval',
    'This context was added by the app, not typed by the user. Treat it as non-authoritative background and do not mention this block unless directly asked about injected context.',
    'a note',
    '[End Orchestrator Memory Context]',
  ].join('\n');
  const indexed = [
    '[Indexed Codebase Context]',
    'Source: Harness indexed codebase search',
    'This context was selected from the persisted codebase index. Use it as a starting point and verify important details against files before editing.',
    'src/a.ts:1-3',
    '[End Indexed Codebase Context]',
  ].join('\n');
  const retrieved = '[Retrieved Context]\nSource: RLM hybrid search\nbody\n[End Retrieved Context]';
  const goal = buildActiveGoalContext({
    metadata: { goal: { objective: 'Ship it.', status: 'active', createdAt: 1, updatedAt: 1 } },
  }) as string;
  const warning = [
    '[SYSTEM: Context Usage Warning]',
    'Your context is at 85% capacity (170000 / 200000 tokens).',
    'To avoid hitting the limit:',
    '1. Do NOT read large files directly — spawn child instances for file reading.',
    '2. Use get_child_summary instead of get_child_output for results.',
    '3. Summarize rather than copying full file contents.',
    '[END SYSTEM WARNING]',
  ].join('\n');
  const history = buildReplayContinuityMessage(
    [
      { id: 'a', timestamp: 1, type: 'user', content: 'first ask' },
      { id: 'b', timestamp: 2, type: 'assistant', content: 'first answer' },
    ],
    { reason: 'history-restore-fallback' },
  ) as string;
  const join = (...parts: string[]): string => parts.join('\n\n');

  it('strips an earlier set queued in front of the current set, in every pairing the queue can make', () => {
    for (const [earlier, current] of [
      [[indexed, retrieved], [indexed, retrieved]],
      [[indexed], [indexed]],
      [[retrieved], [retrieved]],
      [[indexed, retrieved], [indexed]],
      [[memory, indexed], [indexed, retrieved]],
      [[retrieved], [memory]],
      [[memory], [memory, indexed, retrieved, goal]],
      [[memory, indexed, retrieved], [memory, indexed, retrieved, goal]],
    ] as const) {
      expect(stripLeadingHarnessContext(join(...earlier, ...current, guidance, typed))).toBe(typed);
      expect(stripLeadingHarnessContext(join(...earlier, ...current, typed))).toBe(typed);
      expect(startsWithHarnessContext(join(...earlier, ...current, typed))).toBe(true);
    }
  });

  it('strips a context warning between the queued set and the current set, or in front of the current set', () => {
    expect(stripLeadingHarnessContext(join(indexed, warning, indexed, retrieved, guidance, typed))).toBe(typed);
    expect(stripLeadingHarnessContext(join(warning, memory, goal, typed))).toBe(typed);
    expect(stripLeadingHarnessContext(join(retrieved, warning, typed))).toBe(typed);
    expect(stripLeadingHarnessContext(join(warning, typed))).toBe(typed);
    expect(stripLeadingHarnessContext(join(warning.replace('85%', '85.5%'), typed))).toBe(typed);
  });

  it('strips a replay or handoff history preamble in front of the blocks, or alone', () => {
    expect(history.startsWith('<conversation_history>\nResume mode: replay fallback (history-restore-fallback)')).toBe(true);
    expect(stripLeadingHarnessContext(join(history, typed))).toBe(typed);
    expect(stripLeadingHarnessContext(join(history, retrieved, guidance, typed))).toBe(typed);
    expect(stripLeadingHarnessContext(join(history, warning, indexed, goal, typed))).toBe(typed);
    // The CLI trims the blank line when nothing was typed after the preamble.
    expect(stripLeadingHarnessContext(history)).toBe('');
    const handoff = history
      .replace('Resume mode: replay fallback (', 'Resume mode: maintained handoff document (')
      .replace('this archived transcript summary is', 'this incrementally maintained handoff is');
    expect(stripLeadingHarnessContext(join(handoff, indexed, typed))).toBe(typed);
  });

  it('strips the plan-mode ultrathink line only when a Harness prefix follows it', () => {
    expect(stripLeadingHarnessContext(join('ultrathink', indexed, retrieved, indexed, guidance, typed))).toBe(typed);
    expect(stripLeadingHarnessContext(join('ultrathink', history, typed))).toBe(typed);
    expect(stripLeadingHarnessContext(join('ultrathink', guidance, typed))).toBe(typed);
    // Nothing of Harness's follows, so it may be the user's own word.
    for (const text of [join('ultrathink', typed), 'ultrathink', 'ultrathink\n\n', ` ultrathink\n\n${indexed}\n\n${typed}`]) {
      expect(stripLeadingHarnessContext(text)).toBe(text);
      expect(startsWithHarnessContext(text)).toBe(false);
    }
    expect(stripLeadingHarnessContext(join('Ultrathink', indexed, typed))).toBe(join('Ultrathink', indexed, typed));
  });

  it('never reaches past the user\'s own words', () => {
    const afterWords = `${typed}\n\n${join(indexed, retrieved, guidance)}`;
    expect(stripLeadingHarnessContext(join(indexed, afterWords))).toBe(afterWords);
    expect(stripLeadingHarnessContext(join(indexed, retrieved, typed, indexed, retrieved))).toBe(join(typed, indexed, retrieved));
    expect(stripLeadingHarnessContext(join(history, typed, history))).toBe(join(typed, history));
    expect(stripLeadingHarnessContext(join(warning, typed, warning))).toBe(join(typed, warning));
    expect(stripLeadingHarnessContext(join('ultrathink', indexed, typed, 'ultrathink'))).toBe(join(typed, 'ultrathink'));
  });

  it('allows at most two sets, one warning, one history, and nothing after the goal', () => {
    // A third set, a second warning, a block after the goal, and a history that is not first stay as text.
    expect(stripLeadingHarnessContext(join(indexed, retrieved, indexed, retrieved, indexed, typed))).toBe(join(indexed, typed));
    expect(stripLeadingHarnessContext(join(memory, memory, memory, typed))).toBe(join(memory, typed));
    expect(stripLeadingHarnessContext(join(warning, warning, typed))).toBe(join(warning, typed));
    expect(stripLeadingHarnessContext(join(indexed, warning, indexed, warning, typed))).toBe(join(warning, typed));
    expect(stripLeadingHarnessContext(join(goal, memory, typed))).toBe(join(memory, typed));
    expect(stripLeadingHarnessContext(join(memory, goal, goal, typed))).toBe(join(goal, typed));
    expect(stripLeadingHarnessContext(join(indexed, history, typed))).toBe(join(history, typed));
    expect(stripLeadingHarnessContext(join(history, history, typed))).toBe(join(history, typed));
    // The warning is queued ahead of the current set, never after it.
    expect(stripLeadingHarnessContext(join(indexed, retrieved, indexed, warning, typed))).toBe(join(warning, typed));
    expect(stripLeadingHarnessContext(join(memory, goal, warning, typed))).toBe(join(warning, typed));
    // Three rising blocks are one set, so a fourth after the goal is still refused.
    expect(stripLeadingHarnessContext(join(memory, indexed, retrieved, goal, retrieved, typed))).toBe(join(retrieved, typed));
  });

  it('leaves a piece whose wording was edited, or that was cut short, in the text', () => {
    const edited = history.replace('Do not repeat them', 'Please repeat them');
    expect(stripLeadingHarnessContext(join(edited, typed))).toBe(join(edited, typed));
    const noTail = history.slice(0, history.indexOf('</conversation_history>'));
    expect(stripLeadingHarnessContext(join(noTail, typed))).toBe(join(noTail, typed));
    // Right shape, wrong separator: the join always adds a blank line (or the turn ends there).
    expect(stripLeadingHarnessContext(`${history}\n${typed}`)).toBe(`${history}\n${typed}`);
    expect(stripLeadingHarnessContext(`${history} ${typed}`)).toBe(`${history} ${typed}`);
    const oddReason = history.replace('Resume mode: replay fallback', 'Resume mode: something else');
    expect(stripLeadingHarnessContext(join(oddReason, typed))).toBe(join(oddReason, typed));
    for (const bad of [
      warning.replace('85%', 'lots'),
      warning.replace('Do NOT', 'Do not'),
      warning.replace('[END SYSTEM WARNING]', '[END]'),
      warning.replace('(170000 / 200000 tokens)', '(170000 tokens)'),
    ]) {
      expect(stripLeadingHarnessContext(join(bad, indexed, typed))).toBe(join(bad, indexed, typed));
    }
    expect(stripLeadingHarnessContext(join(indexed, warning.replace('85%', 'x'), retrieved, typed))).toBe(
      join(warning.replace('85%', 'x'), retrieved, typed),
    );
  });

  it('needs the blank line after a block, so a block pasted alone is not taken for Harness text', () => {
    for (const lone of [retrieved, memory, warning, goal]) {
      expect(stripLeadingHarnessContext(lone)).toBe(lone);
      expect(startsWithHarnessContext(lone)).toBe(false);
    }
    expect(stripLeadingHarnessContext(`${indexed}\n\n${retrieved}`)).toBe(retrieved);
  });

  it('stays linear on doubled input, repeated heads and a history preamble with no closing lines', () => {
    const timed = (text: string): number => {
      const started = performance.now();
      const result = stripLeadingHarnessContext(text);
      expect(result).toBe(text);
      return performance.now() - started;
    };
    const bodyOf = (n: number): string => 'x\n'.repeat(n);
    // Each head is present and its tail is not, in every position the walk tries.
    const cases = [
      `[Retrieved Context]\nSource: RLM semantic search\n${bodyOf(300_000)}`,
      `${history.slice(0, history.indexOf('\n\nRecent transcript'))}\n${bodyOf(300_000)}`,
      `${'[Retrieved Context]\nSource: RLM hybrid search\n'.repeat(20_000)}`,
      `${'[Indexed Codebase Context]\n'.repeat(20_000)}`,
      `${warning.slice(0, 60)}${bodyOf(300_000)}`,
      `ultrathink\n\n${' \n'.repeat(300_000)}`,
    ];
    for (const text of cases) expect(timed(text)).toBeLessThan(1_500);
    // A long, real, doubled prefix followed by a long typed text is also fast and exact.
    const bigBody = 'line of retrieved text\n'.repeat(100_000);
    const big = `[Retrieved Context]\nSource: RLM hybrid search\n${bigBody}[End Retrieved Context]`;
    const tail = 'typed words\n'.repeat(100_000);
    const started = performance.now();
    expect(stripLeadingHarnessContext(join(big, warning, big, tail))).toBe(tail);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});

describe('shouldReceiveHarnessGuide', () => {
  it('gives person-started root sessions the guide', () => {
    expect(shouldReceiveHarnessGuide({ depth: 0 }, {})).toBe(true);
  });

  it('omits it for children, automation runs, plan-queue roots, repo jobs and reviewers', () => {
    expect(shouldReceiveHarnessGuide({ depth: 1 }, {})).toBe(false);
    expect(shouldReceiveHarnessGuide({ depth: 0 }, { metadata: { automationId: 'a1' } })).toBe(false);
    expect(
      shouldReceiveHarnessGuide({ depth: 0 }, { metadata: { planQueueRunId: 'p1' } }),
    ).toBe(false);
    expect(
      shouldReceiveHarnessGuide({ depth: 0 }, { metadata: { spendPurpose: 'repo-job' } }),
    ).toBe(false);
    expect(shouldReceiveHarnessGuide({ depth: 0 }, { metadata: { pingPongReviewer: true } })).toBe(
      false,
    );
    expect(shouldReceiveHarnessGuide({ depth: 0 }, { parentId: 'parent-1' })).toBe(false);
  });
});
