/**
 * The phone imports the shared status presenter directly. The lock-screen
 * widget (`HarnessLiveActivity.swift`) keeps the native colour fallback. This spec is what keeps the mirrors
 * honest: it reads the real presenter, the real Mac push mapping, the real
 * phone mapping and the real Swift source, and fails when any of them drifts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstanceStatus } from '@contracts/types/instance-events';
import { ALL_INSTANCE_STATUSES } from '../../../../../src/shared/attention/attention-level';
import {
  INSTANCE_STATUS_LABELS,
  INSTANCE_STATUS_TONE_COLORS,
  presentInstanceStatus,
  type InstanceStatusLabel,
  type InstanceStatusTone,
} from '../../../../../src/shared/attention/instance-status-presentation';
import {
  liveActivityDisplayLabel as macLiveActivityWords,
  liveActivityStatusLabel as macLiveActivityKey,
} from '../../../../../src/main/mobile-gateway/mobile-gateway-push';
import { accountFamilyName, providerName } from '../../../../../src/shared/display-names';
import { accountFamilyDisplayName, providerDisplayName } from '../features/new-session/new-session.presentation';
import {
  displayStatusLabel,
  displayStatusTone,
  isLiveActivityCandidate,
  liveActivityStatusLabel as phoneLiveActivityKey,
  needsAttention,
  statusColor,
  statusLabel,
} from './status';

const WIDGET = readFileSync(
  join(__dirname, '../../../resources/native/HarnessWidgets/HarnessLiveActivity.swift'),
  'utf8',
);
const APP_DELEGATE = readFileSync(join(__dirname, '../../../ios/App/App/AppDelegate.swift'), 'utf8');
const LIVE_ACTIVITY_SERVICE = readFileSync(join(__dirname, 'live-activity.service.ts'), 'utf8');

/** The `ContentState` struct of a Swift source, without comments or layout. */
function contentStateShape(source: string): string {
  const start = source.indexOf('public struct ContentState: Codable, Hashable {');
  expect(start, 'ContentState must exist').toBeGreaterThan(-1);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length)
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The cases of one `switch` in the widget, by function name; `default` holds the fallback. */
function widgetSwitch(funcName: string): Map<string, string> {
  const start = WIDGET.indexOf(`func ${funcName}(`);
  expect(start, `${funcName} must exist in HarnessLiveActivity.swift`).toBeGreaterThan(-1);
  const next = WIDGET.indexOf('private func ', start + 1);
  const body = WIDGET.slice(start, next === -1 ? undefined : next);
  const cases = new Map<string, string>();
  for (const match of body.matchAll(/case\s+((?:"[^"]*"\s*,\s*)*"[^"]*")\s*:\s*return\s+("[^"]*"|\.\w+)/g)) {
    for (const key of match[1]!.matchAll(/"([^"]*)"/g)) cases.set(key[1]!, match[2]!.replaceAll('"', ''));
  }
  const fallback = /default\s*:\s*return\s+("[^"]*"|\.\w+)/.exec(body);
  cases.set('default', fallback ? fallback[1]!.replaceAll('"', '') : '');
  return cases;
}

const WIDGET_COLOR_BY_TONE: Record<InstanceStatusTone, string> = {
  attention: '.orange',
  danger: '.red',
  warning: '.red',
  working: '.blue',
  thinking: '.blue',
  stopping: '.blue',
  background: '.blue',
  ok: '.green',
  quiet: '.gray',
  asleep: '.gray',
};

/** One status that stands for each label when the widget (which only sees a label) is checked. */
const REPRESENTATIVE: Record<InstanceStatusLabel, InstanceStatus> = {
  Working: 'busy',
  Thinking: 'thinking_deeply',
  'Needs your answer': 'waiting_for_input',
  'Needs your OK': 'waiting_for_permission',
  Restarting: 'respawning',
  Stopping: 'interrupting',
  Asleep: 'hibernated',
  Stopped: 'terminated',
  Problem: 'error',
  Ready: 'idle',
};

describe('the phone status colours follow the desktop tones', () => {
  it.each(ALL_INSTANCE_STATUSES.map((status) => [status] as const))('%s', (status) => {
    expect(statusColor(status)).toBe(presentInstanceStatus(status).color);
    expect(displayStatusTone({ status })).toBe(presentInstanceStatus(status).tone);
  });

  it('flags the same sessions as needing you', () => {
    for (const status of ALL_INSTANCE_STATUSES) {
      expect(needsAttention(status)).toBe(presentInstanceStatus(status).needsYou);
    }
  });
});

describe('the lock-screen key is the same on the Mac and on the phone', () => {
  it('agrees for every status that can start or update a Live Activity', () => {
    const candidates = ALL_INSTANCE_STATUSES.filter((status) => {
      const presentation = presentInstanceStatus(status);
      return presentation.needsYou || presentation.spinner || status === 'initializing' || status === 'respawning';
    });
    expect(candidates.length).toBeGreaterThan(5);
    for (const status of candidates) {
      expect(phoneLiveActivityKey({ status }), status).toBe(macLiveActivityKey(status));
    }
  });
});

describe('the lock-screen widget speaks the shared status words', () => {
  const labels = widgetSwitch('displayLabel');

  it('translates each key the Mac and the phone send into the presenter label', () => {
    expect(labels.get('waiting')).toBe(presentInstanceStatus('waiting_for_input').label);
    expect(labels.get('needs approval')).toBe(presentInstanceStatus('waiting_for_permission').label);
    expect(labels.get('error')).toBe(presentInstanceStatus('error').label);
    expect(labels.get('idle')).toBe(presentInstanceStatus('idle').label);
    expect(labels.get('done')).toBe(presentInstanceStatus('idle').label);
    expect(labels.get('default')).toBe(presentInstanceStatus('busy').label);
  });

  it('knows every key the Mac can send', () => {
    for (const status of ALL_INSTANCE_STATUSES) {
      const key = macLiveActivityKey(status);
      expect(labels.has(key) || key === 'working', `widget has no words for "${key}"`).toBe(true);
    }
  });

  it('colours every shared label by its desktop tone, in both vocabularies', () => {
    const colors = widgetSwitch('statusColor');
    const colorOf = (status: string): string => colors.get(status.toLowerCase()) ?? colors.get('default') ?? '';
    for (const label of INSTANCE_STATUS_LABELS) {
      const { tone } = presentInstanceStatus(REPRESENTATIVE[label]);
      expect(colorOf(label), `widget colour for "${label}"`).toBe(WIDGET_COLOR_BY_TONE[tone]);
    }
    for (const status of ALL_INSTANCE_STATUSES) {
      const key = macLiveActivityKey(status);
      const family = presentInstanceStatus(REPRESENTATIVE[
        key === 'waiting' ? 'Needs your answer'
          : key === 'needs approval' ? 'Needs your OK'
            : key === 'error' ? 'Problem'
              : key === 'idle' ? 'Ready' : 'Working'
      ]);
      expect(colorOf(key), `widget colour for key "${key}"`).toBe(WIDGET_COLOR_BY_TONE[family.tone]);
    }
  });

  it('gives a question and an approval the same compact symbol, and a problem its own', () => {
    const symbols = widgetSwitch('shortStatus');
    const symbolOf = (status: string): string => symbols.get(status.toLowerCase()) ?? symbols.get('default') ?? '';
    expect(symbolOf('waiting')).toBe('?');
    expect(symbolOf('needs approval')).toBe('?');
    expect(symbolOf('Needs your answer')).toBe('?');
    expect(symbolOf('Needs your OK')).toBe('?');
    expect(symbolOf('error')).toBe('!');
    expect(symbolOf('Problem')).toBe('!');
    expect(symbolOf('idle')).toBe('✓');
    expect(symbolOf('Ready')).toBe('✓');
    expect(symbolOf('working')).toBe('…');
  });

  it('does not show the busy ellipsis for a session that is asleep or stopped', () => {
    const symbols = widgetSwitch('shortStatus');
    const symbolOf = (status: string): string => symbols.get(status.toLowerCase()) ?? symbols.get('default') ?? '';
    expect(symbolOf('Asleep')).not.toBe(symbolOf('working'));
    expect(symbolOf('Stopped')).not.toBe(symbolOf('working'));
    expect(symbolOf('Thinking')).toBe(symbolOf('working'));
    expect(symbolOf('Restarting')).toBe(symbolOf('working'));
  });
});

describe('the phone words are the desktop labels', () => {
  it.each(ALL_INSTANCE_STATUSES.map((status) => [status] as const))('%s', (status) => {
    expect(statusLabel(status)).toBe(presentInstanceStatus(status).label);
  });

  it('uses only labels from the presenter\'s closed list', () => {
    const labels = new Set<string>(INSTANCE_STATUS_LABELS);
    for (const status of [...ALL_INSTANCE_STATUSES, 'a-status-from-a-newer-app']) {
      expect(labels.has(statusLabel(status)), status).toBe(true);
    }
  });

  it('reads a status it has never heard of the way the presenter does', () => {
    expect(statusLabel('a-status-from-a-newer-app'))
      .toBe(presentInstanceStatus('a-status-from-a-newer-app' as InstanceStatus).label);
  });

  it('never says "busy", "waiting for permission" or a raw status with underscores', () => {
    for (const status of ALL_INSTANCE_STATUSES) {
      expect(statusLabel(status)).not.toMatch(/busy|waiting for|_|-/i);
    }
  });

  it('puts a question or an approval ahead of a running loop, and otherwise says the loop is running', () => {
    expect(displayStatusLabel({ status: 'waiting_for_input', isLooping: true }))
      .toBe(presentInstanceStatus('waiting_for_input').label);
    expect(displayStatusLabel({ status: 'waiting_for_permission', isLooping: true }))
      .toBe(presentInstanceStatus('waiting_for_permission').label);
    expect(displayStatusLabel({ status: 'idle', isLooping: true })).toBe('Loop running');
  });
});

describe('the exact words for the lock screen', () => {
  it('are the same on the Mac and on the phone for every status that can start or update an activity', () => {
    const candidates = ALL_INSTANCE_STATUSES.filter((status) => isLiveActivityCandidate({ status }));
    expect(candidates.length).toBeGreaterThan(5);
    for (const status of candidates) {
      expect(displayStatusLabel({ status }), status).toBe(macLiveActivityWords(status));
    }
  });

  it('keep Thinking, Restarting, Stopping, Asleep and Stopped apart where the short key folds them together', () => {
    const folded: Record<string, string[]> = { working: [], idle: [] };
    for (const status of ALL_INSTANCE_STATUSES) {
      const key = macLiveActivityKey(status);
      if (key === 'working' || key === 'idle') folded[key]!.push(macLiveActivityWords(status));
    }
    for (const label of ['Thinking', 'Restarting', 'Stopping']) expect(folded['working']).toContain(label);
    for (const label of ['Asleep', 'Stopped']) expect(folded['idle']).toContain(label);
  });
});

describe('the widget and the app share one Codable shape, and the widget shows what it is sent', () => {
  it('declare the same ContentState, with the exact words optional so older activities still decode', () => {
    expect(contentStateShape(WIDGET)).toBe(contentStateShape(APP_DELEGATE));
    expect(contentStateShape(WIDGET)).toContain('var displayLabel: String?');
    expect(contentStateShape(WIDGET)).toContain('var displayTone: String?');
    expect(contentStateShape(WIDGET)).toContain('var status: String');
    expect(contentStateShape(WIDGET)).toContain('var detail: String');
  });

  it('has the app pass displayLabel through both start and update', () => {
    const passes = APP_DELEGATE.match(/displayLabel: call\.getString\("displayLabel"\)/g) ?? [];
    expect(passes).toHaveLength(2);
  });

  it('has the phone send displayLabel on both start and update', () => {
    expect(LIVE_ACTIVITY_SERVICE).toMatch(/displayLabel: displayStatusLabel\(hero\)/);
    expect(LIVE_ACTIVITY_SERVICE).toMatch(/displayTone: displayStatusTone\(hero\)/);
    expect(LIVE_ACTIVITY_SERVICE.match(/displayTone: next\.displayTone/g)).toHaveLength(2);
    expect(APP_DELEGATE.match(/displayTone: call\.getString\("displayTone"\)/g)).toHaveLength(2);
    expect(LIVE_ACTIVITY_SERVICE).toMatch(/LiveActivity\.start\(\{[^}]*displayLabel: next\.displayLabel/s);
    expect(LIVE_ACTIVITY_SERVICE).toMatch(/LiveActivity\.update\(\{[^}]*displayLabel: next\.displayLabel/s);
  });

  it('shows the sender\'s words as sent, and falls back to the key only when it sent none', () => {
    expect(WIDGET).toMatch(/return senderWords\(state\) \?\? displayLabel\(state\.status\)/);
    expect(WIDGET).toMatch(/return senderWords\(state\) \?\? state\.status/);
    // Every place that draws the words, the colour or the symbol goes through them.
    expect(WIDGET).not.toMatch(/Text\(displayLabel\(context\.state\.status\)\)/);
    expect(WIDGET).not.toMatch(/statusColor\(context\.state\.status\)/);
    expect(WIDGET).not.toMatch(/shortStatus\(context\.state\.status\)/);
    expect(WIDGET).not.toMatch(/statusDot\(context\.state\.status\)/);
    expect(WIDGET.match(/Text\(shownWords\(context\.state\)\)/g) ?? []).toHaveLength(2);
  });

  it('colours every label the Mac or the phone can send, from the words themselves', () => {
    const colors = widgetSwitch('statusColor');
    const colorOf = (words: string): string => colors.get(words.toLowerCase()) ?? colors.get('default') ?? '';
    const sent = new Set<string>([
      ...ALL_INSTANCE_STATUSES.map((status) => macLiveActivityWords(status)),
      ...ALL_INSTANCE_STATUSES.map((status) => displayStatusLabel({ status })),
      displayStatusLabel({ status: 'idle', isLooping: true }),
    ]);
    for (const words of sent) {
      if (words === 'Loop running') {
        expect(colorOf(words), words).toBe(WIDGET_COLOR_BY_TONE.working);
        continue;
      }
      const label = words as InstanceStatusLabel;
      expect(INSTANCE_STATUS_LABELS, words).toContain(label);
      expect(colorOf(words), `widget colour for "${words}"`)
        .toBe(WIDGET_COLOR_BY_TONE[presentInstanceStatus(REPRESENTATIVE[label]).tone]);
    }
  });
});

describe('the phone provider words follow the shared names', () => {
  const SESSION_PROVIDERS = ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode', 'ollama', 'auto'];

  it.each(SESSION_PROVIDERS)('names %s the way providerName does', (id) => {
    expect(providerDisplayName(id)).toBe(providerName(id));
  });

  it.each(SESSION_PROVIDERS)('names the account behind %s the way accountFamilyName does', (id) => {
    expect(accountFamilyDisplayName(id)).toBe(accountFamilyName(id));
  });

  it('keeps OpenCode a provider and MiMo an account family', () => {
    expect(providerDisplayName('opencode')).toBe('OpenCode');
    expect(accountFamilyDisplayName('opencode')).toBe('MiMo');
  });
});


describe('exact status tones on a rebuilt widget', () => {
  it('uses every desktop tone colour and falls back for older activities', () => {
    const entries = [...WIDGET.matchAll(/case "([a-z]+)": return toneColor\(0x([0-9a-f]{6})\)/g)]
      .map((entry) => [entry[1], `#${entry[2]}`]);
    expect(Object.fromEntries(entries)).toEqual({ ...INSTANCE_STATUS_TONE_COLORS, loop: '#a78bfa' });
    expect(displayStatusTone({ status: 'idle', isLooping: true })).toBe('loop');
    expect(displayStatusTone({ status: 'waiting_for_input', isLooping: true })).toBe('attention');
    expect(WIDGET).toContain('switch state.displayTone');
    expect(WIDGET).toContain('default: return statusColor(colourKey(state))');
    expect(WIDGET).toContain('.fill(activityColor(state))');
    expect(WIDGET).toContain('.foregroundStyle(activityColor(context.state))');
    // The symbol still uses the words; a warning Stopping stays a stopping symbol.
    expect(WIDGET).toContain('shortStatus(colourKey(context.state))');
  });
});
