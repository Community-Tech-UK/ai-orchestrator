import { describe, expect, it } from 'vitest';
import {
  CONTINUITY_PACKAGE_MARKER,
  OBSERVATION_MAX_CHARS,
  TOOL_RESULT_MAX_CHARS,
  extractObservationEvents,
  selectDecisionLogEntries,
  type ObservationSourceMessage,
} from './observation-extractor';

// Obvious placeholder in a detectable shape — not a real credential.
const FAKE_GITHUB_TOKEN = `ghp_${'x'.repeat(36)}`;

function msg(type: string, content: string, extra: Partial<ObservationSourceMessage> = {}): ObservationSourceMessage {
  return { type, content, timestamp: 1000, ...extra };
}

function extract(messages: ObservationSourceMessage[], max?: number) {
  return extractObservationEvents(messages, { instanceId: 'inst-1', ...(max === undefined ? {} : { max }) });
}

describe('extractObservationEvents', () => {
  it.each([
    ['DECISION', 'decision', 1],
    ['ERROR', 'error', 1],
    ['BUG', 'error', 1],
    ['ARCHITECTURE', 'decision', 2],
    ['IMPORTANT', 'discovery', 2],
  ] as const)('maps the %s: tag to a %s event with priority %d', (tag, type, priority) => {
    const events = extract([msg('assistant', `Some prose.\n${tag}: use the sqlite store for events\nMore prose.`)]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      instanceId: 'inst-1',
      turn: 0,
      timestamp: 1000,
      type,
      priority,
      content: 'use the sqlite store for events',
      metadata: { tag },
      sourceType: 'heuristic',
    });
    expect(events[0]?.id).toMatch(/^obs_/);
  });

  it('accepts bold and bulleted tags but ignores lowercase prose like "Error:"', () => {
    const events = extract([msg('user', '- **DECISION:** keep retries at three\nError: this is ordinary prose')]);
    expect(events.map((e) => e.content)).toEqual(['keep retries at three']);
  });

  it('records error messages as priority-1 errors using their first non-empty line', () => {
    const events = extract([msg('error', '\nProcess exited with code 1\nstack line')]);
    expect(events).toEqual([expect.objectContaining({ type: 'error', priority: 1, content: 'Process exited with code 1' })]);
  });

  it('records tool results as priority 3, capped at 150 chars, with the tool name', () => {
    const long = `output ${'y'.repeat(400)}`;
    const [event] = extract([msg('tool_result', long, { metadata: { toolName: 'Bash' } })]);
    expect(event).toMatchObject({ type: 'tool_result', priority: 3, metadata: { toolName: 'Bash' } });
    expect(event?.content.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    expect(event?.content.endsWith('...')).toBe(true);
  });

  it('truncates long tagged lines', () => {
    const [event] = extract([msg('assistant', `DECISION: ${'z'.repeat(1000)}`)]);
    expect(event?.content.length).toBeLessThanOrEqual(OBSERVATION_MAX_CHARS);
  });

  it('turns todo/next/checkbox markers into priority-3 task_progress events', () => {
    const events = extract([msg('assistant', '- [ ] wire the IPC handler\nTODO: add a spec\nnext: run lint')]);
    expect(events.map((e) => [e.type, e.priority, e.content])).toEqual([
      ['task_progress', 3, 'wire the IPC handler'],
      ['task_progress', 3, 'add a spec'],
      ['task_progress', 3, 'run lint'],
    ]);
  });

  it('skips the restart continuity package, which quotes earlier turns', () => {
    const events = extractObservationEvents([
      // Recent turns are copied in raw, so a multi-line message keeps its tag at a line start.
      { type: 'user', content: `${CONTINUITY_PACKAGE_MARKER}\nRecent turns:\n- Assistant: Plan below.\nDECISION: store rows in SQLite`, timestamp: 50 },
    ], { instanceId: 'inst-1' });

    expect(events).toEqual([]);
  });

  it('returns nothing for empty input, untagged prose, and tool_use/system messages', () => {
    expect(extract([])).toEqual([]);
    expect(extract([
      msg('assistant', 'Just chatting about the weather.'),
      msg('tool_use', 'DECISION: not from a tool call'),
      msg('system', 'DECISION: not from a system banner'),
      msg('assistant', '   '),
    ])).toEqual([]);
  });

  it('redacts secrets in every event kind before truncating', () => {
    const events = extract([
      msg('assistant', `DECISION: authenticate with ${FAKE_GITHUB_TOKEN}`),
      msg('error', `push failed for ${FAKE_GITHUB_TOKEN}`),
      msg('tool_result', `export password=hunter2 && ${FAKE_GITHUB_TOKEN}`),
    ]);
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.content).not.toContain(FAKE_GITHUB_TOKEN);
      expect(event.content).not.toContain('hunter2');
    }
    expect(events[0]?.content).toContain('[REDACTED');
  });

  it('de-duplicates identical events case-insensitively across messages', () => {
    const events = extract([
      msg('assistant', 'DECISION: Use SQLite'),
      msg('assistant', 'DECISION: use sqlite'),
      msg('assistant', 'IMPORTANT: use sqlite'),
    ]);
    expect(events.map((e) => e.type)).toEqual(['decision', 'discovery']);
  });

  it('caps at max, keeping the most important then most recent, in transcript order', () => {
    const messages = [
      msg('tool_result', 'old tool output'),
      msg('assistant', 'DECISION: first decision'),
      msg('tool_result', 'newer tool output'),
      msg('assistant', 'IMPORTANT: a discovery'),
      msg('assistant', 'DECISION: second decision'),
    ];
    const events = extract(messages, 3);
    expect(events.map((e) => e.content)).toEqual(['first decision', 'a discovery', 'second decision']);
    expect(extract(messages)).toHaveLength(5);
    expect(extract(Array.from({ length: 50 }, (_, i) => msg('assistant', `DECISION: item ${i}`)))).toHaveLength(30);
  });

  it('carries an optional compaction marker id', () => {
    const [event] = extractObservationEvents([msg('assistant', 'DECISION: x')], { instanceId: 'i', compactionMarkerId: 'cmark_1' });
    expect(event?.compactionMarkerId).toBe('cmark_1');
  });
});

describe('selectDecisionLogEntries', () => {
  it('keeps only priority 1-2 events, newest `limit`, in order', () => {
    const events = extract([
      msg('tool_result', 'tool'),
      ...Array.from({ length: 12 }, (_, i) => msg('assistant', `DECISION: d${i}`)),
    ]);
    const selected = selectDecisionLogEntries(events, 10);
    expect(selected).toHaveLength(10);
    expect(selected.every((e) => e.priority <= 2)).toBe(true);
    expect(selected[0]?.content).toBe('d2');
    expect(selected[9]?.content).toBe('d11');
  });
});
