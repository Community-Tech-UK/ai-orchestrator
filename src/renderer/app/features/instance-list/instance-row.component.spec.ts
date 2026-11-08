/**
 * Real-render tests for the instance row.
 *
 * This component had no spec of any kind, and BOTH tooltip regressions in this
 * wave originated here: the Terminate button losing its only hover disclosure,
 * and the status dots nesting inside the leading indicator so two overlapping
 * tooltips opened at once. Neither was caught by a test — the guards that found
 * them afterwards are regex scans of the template source and a synthetic
 * two-span fixture, neither of which renders this markup.
 *
 * So these tests drive the real component with the real directive: hover the
 * real elements, and assert what a user would actually see.
 */
import { ChangeDetectionStrategy, Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { InstanceRowComponent } from './instance-row.component';
import { InstanceStore } from '../../core/state/instance.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import { PendingRequestStore } from '../../core/state/pending-request.store';
import { SessionTodoPeekService } from './session-todo-peek.service';
import type { SideChatAttention } from '../../../../shared/types/side-chat.types';
import type { Instance } from '../../core/state/instance/instance.types';

// This component uses `templateUrl`, so the usual `() => Promise.resolve('')`
// resolver used by sibling specs would render NOTHING and every assertion here
// would pass or fail for the wrong reason. Load the real template; stylesheets
// stay empty because they are irrelevant to markup and naming.
await resolveComponentResources(async (url: string) =>
  (url.endsWith('.html') ? readFileSync(join(__dirname, basename(url)), 'utf8') : ''));

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    displayName: 'Test instance',
    provider: 'claude',
    status: 'idle',
    workingDirectory: '/tmp/project',
    createdAt: 1, historyThreadId: 'thread-1', parentId: null, childrenIds: [], agentId: 'build', agentMode: 'build',
    contextUsage: { used: 0, total: 200000, percentage: 0 }, lastActivity: 2,
    providerSessionId: 'provider-session-1', sessionId: 'session-1', restartEpoch: 0,
    yoloMode: false, launchMode: 'interactive', outputBuffer: [],
    ...overrides,
  };
}

@Component({
  standalone: true,
  imports: [InstanceRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-instance-row [instance]="instance()" [isLooping]="false" [hasChildren]="hasChildren()" [descendantNeedsYou]="descendantNeedsYou()" [needsYouReason]="needsYouReason()" />`,
})
class HostComponent {
  readonly instance = signal<Instance>(makeInstance());
  readonly hasChildren = signal(false);
  readonly descendantNeedsYou = signal(0);
  readonly needsYouReason = signal<string | null>(null);
}

function openTooltips(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[role="tooltip"]'));
}

let nodes: Record<string, { name: string; status: string; connected?: boolean }> = {};
const liveActivities = signal(new Map<string, string>());
const instanceProvider = { provide: InstanceStore, useValue: { liveActivities } };
beforeEach(() => liveActivities.set(new Map()));

describe('InstanceRowComponent — tooltip disclosure', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [instanceProvider,
        { provide: PendingRequestStore, useValue: { forInstance: () => [{ text: 'May I use Bash?' }] } },
        { provide: SessionTodoPeekService, useValue: { peek: () => Promise.resolve('Step 2 of 5: Implement') } },
        { provide: RemoteNodeStore, useValue: { nodeById: (id: string) => nodes[id] ?? null } }],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
    nodes = {};
    expect(openTooltips()).toHaveLength(0);
  });

  function query(selector: string): HTMLElement {
    const el = fixture.nativeElement.querySelector(selector) as HTMLElement | null;
    expect(el, `expected ${selector} to render`).toBeTruthy();
    return el as HTMLElement;
  }

  function hover(el: HTMLElement): void {
    el.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
  }

  // Gate 6: this button's `title` was replaced with an `aria-label` alone,
  // leaving a bare glyph with no hover hint on a session-ending action.
  it.each([
    ['processing', 'Working'], ['thinking_deeply', 'Thinking'],
    ['waiting_for_input', 'Needs your answer'], ['waiting_for_permission', 'Needs your OK'],
    ['respawning', 'Restarting'], ['interrupting', 'Stopping'],
    ['failed', 'Problem'], ['degraded', 'Problem'], ['hibernating', 'Asleep'],
  ] as const)('names %s using the shared status words', (status, label) => {
    fixture.componentInstance.instance.set(makeInstance({ status }));
    fixture.detectChanges();
    expect(query('.leading-indicator').getAttribute('aria-label')).toContain(label);
  });

  it('keeps the live activity line alongside canonical status wording', () => {
    liveActivities.set(new Map([['inst-1', 'Reading the project files']]));
    fixture.componentInstance.instance.set(makeInstance({ status: 'processing' }));
    fixture.detectChanges();
    expect(query('.activity-line').textContent).toContain('Reading the project files');
    expect(query('.leading-indicator').getAttribute('aria-label')).toContain('Working');
    expect(query('.instance-row').getAttribute('aria-label')).toContain('Reading the project files');
  });

  it('uses the approval vocabulary for a pending approval count even while the session is working', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'processing', pendingApprovalCount: 1 }));
    fixture.detectChanges();
    expect(query('.approval-chip').textContent).toContain('Needs your OK');
  });

  it('keeps question wording on the row chip and hover despite a separate pending permission', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'waiting_for_input', pendingApprovalCount: 1 }));
    fixture.detectChanges();
    expect(query('.approval-chip').textContent).toContain('Needs your answer');
    expect(query('.leading-indicator').getAttribute('aria-label')).toContain('Needs your answer');
    hover(query('.instance-name'));
    expect(openTooltips()[0]?.textContent).toContain('Needs your answer');
    expect(openTooltips()[0]?.textContent).not.toContain('Needs your OK');
  });

  it('gives Close session both a hover disclosure and an accessible name', () => {
    const terminate = query('.action-btn.terminate');
    expect(terminate.getAttribute('aria-label')).toBeTruthy();

    hover(terminate);
    const open = openTooltips();
    expect(open).toHaveLength(1);
    expect(open[0]?.textContent?.trim()).not.toBe('');
  });
  it('shows pending text and the cached step through the name-leaf tooltip without enclosing chip tooltips', async () => {
    fixture.componentInstance.instance.set(makeInstance({ displayName: 'Fix login', status: 'waiting_for_permission', pendingApprovalCount: 1 }));
    fixture.detectChanges();
    const name = query('.instance-name'); hover(name);
    expect(name.tabIndex).toBe(0);
    await Promise.resolve(); fixture.detectChanges();
    expect(openTooltips()).toHaveLength(1);
    expect(openTooltips()[0].textContent).toContain('May I use Bash?');
    expect(openTooltips()[0].textContent).toContain('Step 2 of 5: Implement');
    expect(query('.instance-info').hasAttribute('aria-describedby')).toBe(false);
    expect(name.querySelector('.approval-chip')).toBeNull();
  });
  it('names urgent descendants in the visible collapsed-parent text', () => {
    fixture.componentInstance.instance.set(makeInstance({ displayName: 'Parent', childrenIds: ['child'] }));
    fixture.componentInstance.hasChildren.set(true); fixture.componentInstance.descendantNeedsYou.set(1); fixture.detectChanges();
    expect(query('.child-attention').textContent).toContain('1 child needs you');
  });

  it('says why the session needs you in place of its activity line, and in its accessible name', () => {
    fixture.componentInstance.instance.set(makeInstance({ displayName: 'Blog research', status: 'busy' }));
    fixture.componentInstance.needsYouReason.set('Asked you: which council first?');
    fixture.detectChanges();
    expect(query('.needs-you-reason').textContent).toContain('Asked you: which council first?');
    expect(fixture.nativeElement.querySelector('.activity-line')).toBeNull();
    expect(query('.instance-row').getAttribute('aria-label')).toContain('needs you: Asked you: which council first?');
  });

  it('names the leading indicator rather than relying on colour alone', () => {
    const indicator = query('.leading-indicator');
    expect(indicator.getAttribute('role')).toBe('img');
    expect(indicator.getAttribute('aria-label')).toContain('Claude');
  });

  // Gate 7: the attention dot sat INSIDE the leading indicator with its own
  // tooltip, and `mouseenter` fires on an element and every ancestor, so two
  // overlapping popups opened. Gate 9 then pointed out an earlier version of
  // this test dispatched `mouseenter` at the dot and asserted one tooltip —
  // which passes trivially now that the dot has no listener at all. Assert the
  // two things that are actually load-bearing instead.
  it('leaves the status dot as decoration with no tooltip of its own', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'waiting_for_input' }));
    fixture.detectChanges();

    const dot = query('.attention-overlay-dot');
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(dot.getAttribute('aria-label')).toBeNull();
    // `aria-describedby` is what the directive stamps on a host it manages.
    hover(dot);
    expect(openTooltips()).toHaveLength(0);
  });

  it('shows exactly one tooltip when hovering the indicator that contains the dot', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'waiting_for_input' }));
    fixture.detectChanges();

    hover(query('.leading-indicator'));
    expect(openTooltips()).toHaveLength(1);
  });

  // The dots carry no tooltip of their own now, so the indicator's combined
  // label must still say what state the row is in — otherwise de-nesting them
  // silently deleted the disclosure rather than moving it.
  it('folds the attention state into the indicator label', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'waiting_for_input' }));
    fixture.detectChanges();
    expect(query('.leading-indicator').getAttribute('aria-label')).not.toBe('Claude');
  });

  it('folds the hibernated state into the indicator label', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'hibernated' }));
    fixture.detectChanges();
    expect(query('.leading-indicator').getAttribute('aria-label')).toBe('Claude · Asleep — send a message to wake it');
  });

  // The words now come from the one status presenter, so every surface agrees.
  describe('status words', () => {
    function indicatorLabel(overrides: Partial<Instance>): string {
      fixture.componentInstance.instance.set(makeInstance(overrides));
      fixture.detectChanges();
      return query('.leading-indicator').getAttribute('aria-label') ?? '';
    }

    it('tells a question from an approval', () => {
      expect(indicatorLabel({ status: 'waiting_for_input' }))
        .toBe('Claude · Needs your answer — the agent asked you a question');
      expect(indicatorLabel({ status: 'waiting_for_permission' }))
        .toBe('Claude · Needs your OK — the agent is asking permission to do something');
    });

    it('says Working and Thinking for the two long-silent working states, which had no words before', () => {
      expect(indicatorLabel({ status: 'busy' })).toBe('Claude · Working');
      expect(indicatorLabel({ status: 'processing' })).toBe('Claude · Working');
      expect(indicatorLabel({ status: 'thinking_deeply' })).toBe('Claude · Thinking — thinking for a while');
    });

    it('uses plain words for the restart and stop states', () => {
      expect(indicatorLabel({ status: 'respawning' })).toBe('Claude · Restarting — picking up where it left off');
      expect(indicatorLabel({ status: 'interrupting' })).toBe('Claude · Stopping — stopping the current work');
      expect(indicatorLabel({ status: 'initializing' })).toBe('Claude · Working — starting up');
    });

    it('does not mention a failed or lost-connection session by colour alone', () => {
      expect(indicatorLabel({ status: 'failed' })).toBe("Claude · Problem — the session couldn't carry on");
      expect(indicatorLabel({ status: 'degraded' })).toContain('Problem — lost contact with its computer');
    });

    it('explains why a session that looks idle is not: parked on a usage limit', () => {
      expect(indicatorLabel({
        status: 'idle',
        waitReason: { kind: 'quota-park', provider: 'claude', resumeAt: Date.now() + 60_000 },
      })).toBe('Claude · Asleep — paused until your Claude allowance resets');
    });

    it('names each provider once, the same way everywhere', () => {
      const names = (['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode'] as const)
        .map((provider) => indicatorLabel({ provider }));
      expect(names).toEqual([
        'Claude', 'Codex', 'Gemini', 'Antigravity', 'Copilot', 'Cursor', 'Grok', 'OpenCode',
      ]);
    });

    it('calls an OpenCode session "MiMo" only when its model is on the MiMo plan', () => {
      expect(indicatorLabel({ provider: 'opencode', currentModel: 'xiaomi-token-plan-ams/mimo-v2.5-pro' })).toBe('MiMo');
      expect(indicatorLabel({ provider: 'opencode', currentModel: 'aio-mimo-work/mimo-v2.5-pro' })).toBe('MiMo');
      expect(indicatorLabel({ provider: 'opencode', currentModel: 'opencode/big-pickle' })).toBe('OpenCode');
      expect(indicatorLabel({ provider: 'opencode', currentModel: 'openrouter/anthropic/claude-sonnet-4' })).toBe('OpenCode');
      expect(indicatorLabel({ provider: 'opencode', currentModel: undefined })).toBe('OpenCode');
    });
  });

  it('reads "Needs your OK" on the chip beside a pending approval, the same words as the status', () => {
    fixture.componentInstance.instance.set(makeInstance({ pendingApprovalCount: 2 } as Partial<Instance>));
    fixture.detectChanges();
    const chip = query('.approval-chip');
    expect(chip.textContent?.trim()).toBe('Needs your OK');
    hover(chip);
    expect(openTooltips()[0]?.textContent?.trim()).toBe('This session is waiting for you to approve something');
  });

  // Gate 12: the badge showed the node NAME whether the node was healthy or
  // disconnected. "Session may be interrupted" was carried by an amber class
  // and a hover tooltip — colour alone for a sighted user, and nothing at all
  // for anyone who cannot hover a non-focusable span. There was no test at all.
  describe('remote-node badge', () => {
    function renderOnNode(connected: boolean): HTMLElement {
      nodes = { 'node-1': { name: 'windows-pc', status: connected ? 'connected' : 'offline', connected } };
      fixture.componentInstance.instance.set(
        makeInstance({ executionLocation: { type: 'remote', nodeId: 'node-1' } } as Partial<Instance>),
      );
      fixture.detectChanges();
      return query('.remote-badge');
    }

    it('says the node is offline in its visible text, not only in colour', () => {
      expect(renderOnNode(false).textContent).toContain('offline');
    });

    it('does not label a healthy node as offline', () => {
      const badge = renderOnNode(true);
      expect(badge.textContent).toContain('windows-pc');
      expect(badge.textContent).not.toContain('offline');
    });

    it('still explains the consequence on hover', () => {
      hover(renderOnNode(false));
      expect(openTooltips()[0]?.textContent).toContain('session may be interrupted');
    });

    it('speaks of a computer, never of a node', () => {
      hover(renderOnNode(false));
      expect(openTooltips()[0]?.textContent?.trim()).toBe('windows-pc is offline — this session may be interrupted');
    });

    it('says where a healthy session is running in plain words', () => {
      hover(renderOnNode(true));
      expect(openTooltips()[0]?.textContent?.trim()).toBe('Running on windows-pc');
    });

    it('describes a computer that has no name instead of printing its id', () => {
      nodes = { 'node-1': { name: '', status: 'connected', connected: true } };
      fixture.componentInstance.instance.set(
        makeInstance({ executionLocation: { type: 'remote', nodeId: 'node-1' } } as Partial<Instance>),
      );
      fixture.detectChanges();
      expect(query('.remote-badge').textContent?.trim()).toBe('another computer');
    });
  });

  describe('Plan Queue marker', () => {
    it('names the queue role of a queue-spawned session and shows its tooltip', () => {
      fixture.componentInstance.instance.set(makeInstance({ metadata: { planQueueRole: 'verifier' } } as Partial<Instance>));
      fixture.detectChanges();
      const marker = query('.plan-queue-marker');
      expect(marker.getAttribute('aria-label')).toBe('Plan Queue verifier');
      hover(marker);
      expect(openTooltips()[0]?.textContent).toContain('Plan Queue verifier');
    });

    it('is absent for ordinary sessions and for unknown role values', () => {
      expect(fixture.nativeElement.querySelector('.plan-queue-marker')).toBeNull();
      fixture.componentInstance.instance.set(makeInstance({ metadata: { planQueueRole: 'admin' } } as Partial<Instance>));
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.plan-queue-marker')).toBeNull();
    });
  });

  /**
   * Gate 14: `error` status was an 8%-opacity red row background and `yoloMode`
   * a 14%-opacity inset border, with neither named in text, aria, or a tooltip
   * anywhere in the row. Colour alone (WCAG 1.4.1) for an errored session, and
   * for auto-approve — a mode in which tool calls run without asking.
   *
   * The tooltip allowlist guard could not see either: neither element carries a
   * tooltip, which is the guard's documented blind spot.
   */
  describe('states that were previously colour-only', () => {
    function row(): HTMLElement {
      return query('.instance-row');
    }

    it('names an errored instance in the row accessible name', () => {
      fixture.componentInstance.instance.set(makeInstance({ status: 'error' }));
      fixture.detectChanges();
      expect(row().getAttribute('aria-label')).toContain('problem');
    });

    it('names a failed or disconnected instance the same way, not only an errored one', () => {
      for (const status of ['failed', 'degraded'] as const) {
        fixture.componentInstance.instance.set(makeInstance({ status }));
        fixture.detectChanges();
        expect(row().getAttribute('aria-label')).toContain('problem');
      }
    });

    it('names auto-approve mode in the row accessible name', () => {
      fixture.componentInstance.instance.set(makeInstance({ yoloMode: true } as Partial<Instance>));
      fixture.detectChanges();
      expect(row().getAttribute('aria-label')).toContain('auto-approve');
    });

    it('names both when an auto-approve instance errors', () => {
      fixture.componentInstance.instance.set(
        makeInstance({ status: 'error', yoloMode: true } as Partial<Instance>),
      );
      fixture.detectChanges();
      const label = row().getAttribute('aria-label') ?? '';
      expect(label).toContain('problem');
      expect(label).toContain('auto-approve');
    });

    it('says neither on an ordinary idle instance', () => {
      const label = row().getAttribute('aria-label') ?? '';
      expect(label).toContain('Select session');
      expect(label).not.toContain('problem');
      expect(label).not.toContain('auto-approve');
    });

    it('also names the error on the leading indicator, which drives its tooltip', () => {
      fixture.componentInstance.instance.set(makeInstance({ status: 'error' }));
      fixture.detectChanges();
      expect(query('.leading-indicator').getAttribute('aria-label')).toContain('Problem');
    });
  });
});

/**
 * N2 — a critical tool loop must reach the row.
 *
 * The two statuses `needsAttention` used to check (`waiting_for_input`,
 * `waiting_for_permission`) could never fire for this: a looping session is
 * mid-turn and reads as `busy`, which is indistinguishable from healthy work
 * from outside. So these assert the badge appears on `busy` specifically, and
 * that a row reads only its OWN instance's alert.
 */
describe('InstanceRowComponent — tool-loop badge (N2)', () => {
  let fixture: ComponentFixture<HostComponent>;
  let looping: Set<string>;

  beforeEach(async () => {
    looping = new Set<string>();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        instanceProvider,
        { provide: RemoteNodeStore, useValue: { nodeById: () => null } },
        {
          provide: ToolLoopAlertStore,
          useValue: { hasCriticalAlert: (id: string) => looping.has(id) },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  afterEach(() => fixture.destroy());

  function attentionDot(): Element | null {
    return fixture.nativeElement.querySelector('.attention-overlay-dot');
  }

  it('shows no attention dot for an ordinary busy instance', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'busy' }));
    fixture.detectChanges();
    expect(attentionDot()).toBeNull();
  });

  it('shows the attention dot mid-turn when its own instance is looping', () => {
    looping.add('inst-1');
    fixture.componentInstance.instance.set(makeInstance({ status: 'busy' }));
    fixture.detectChanges();
    expect(attentionDot()).not.toBeNull();
  });

  it('reads only its own row — another instance looping does not badge it', () => {
    looping.add('some-other-instance');
    fixture.componentInstance.instance.set(makeInstance({ status: 'busy' }));
    fixture.detectChanges();
    expect(attentionDot()).toBeNull();
  });

  it('names the loop in the activity label, leading the underlying status', () => {
    looping.add('inst-1');
    fixture.componentInstance.instance.set(makeInstance({ status: 'busy' }));
    fixture.detectChanges();
    // The leading indicator's accessible name is the structured one; the row's
    // own label is just "Select instance <name>".
    const indicator = fixture.nativeElement.querySelector('.leading-indicator') as HTMLElement;
    expect(indicator.getAttribute('aria-label') ?? '').toContain('Tool loop detected');
  });
});

/**
 * An idle session whose provider still owns background work (a background
 * shell or agent) is waiting, not finished. It needs its own indicator: not the
 * busy spinner (the CLI is not mid-turn) and not the amber attention dot (it is
 * not waiting on the user).
 */
describe('InstanceRowComponent — waiting on background work', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        instanceProvider,
        { provide: RemoteNodeStore, useValue: { nodeById: () => null } },
        { provide: ToolLoopAlertStore, useValue: { hasCriticalAlert: () => false } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  afterEach(() => fixture.destroy());

  function badge(): HTMLElement {
    return fixture.nativeElement.querySelector('.provider-badge') as HTMLElement;
  }

  function indicatorLabel(): string {
    return (fixture.nativeElement.querySelector('.leading-indicator') as HTMLElement).getAttribute('aria-label') ?? '';
  }

  it.each(['claude', 'codex'] as const)('marks an idle %s session that still owns background work, and names it', (provider) => {
    fixture.componentInstance.instance.set(makeInstance({
      provider,
      status: 'idle',
      backgroundWork: { count: 2, since: Date.now() - 5_000 },
    }));
    fixture.detectChanges();

    expect(badge().classList).toContain('provider-background-waiting');
    expect(badge().classList).not.toContain('provider-busy');
    expect(fixture.nativeElement.querySelector('.attention-overlay-dot')).toBeNull();
    expect(indicatorLabel()).toContain('Waiting on 2 background tasks');
  });

  it('uses the singular for one task', () => {
    fixture.componentInstance.instance.set(makeInstance({
      status: 'ready',
      backgroundWork: { count: 1, since: Date.now() },
    }));
    fixture.detectChanges();

    expect(indicatorLabel()).toContain('Waiting on 1 background task');
    expect(indicatorLabel()).not.toContain('tasks');
  });

  it('lets the busy spinner win while a turn is running', () => {
    fixture.componentInstance.instance.set(makeInstance({
      status: 'busy',
      backgroundWork: { count: 1, since: Date.now() },
    }));
    fixture.detectChanges();

    expect(badge().classList).toContain('provider-busy');
    expect(badge().classList).not.toContain('provider-background-waiting');
  });

  it('shows nothing extra for an idle session with no background work', () => {
    fixture.componentInstance.instance.set(makeInstance({ status: 'idle' }));
    fixture.detectChanges();

    expect(badge().classList).not.toContain('provider-background-waiting');
    expect(indicatorLabel()).toBe('Claude');
  });
});

describe('InstanceRowComponent — sidechat badge', () => {
  let fixture: ComponentFixture<HostComponent>;
  const attentionByThread = new Map<string, SideChatAttention>();
  const requestOpen = vi.fn();

  beforeEach(async () => {
    attentionByThread.clear();
    requestOpen.mockClear();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        instanceProvider,
        { provide: RemoteNodeStore, useValue: { nodeById: () => null } },
        { provide: ToolLoopAlertStore, useValue: { hasCriticalAlert: () => false } },
        {
          provide: SideChatStore,
          useValue: {
            attentionFor: (parent: { historyThreadId: string }) => attentionVersion() >= 0
              ? attentionByThread.get(parent.historyThreadId) ?? null
              : null,
            requestOpen,
          },
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
  });

  afterEach(() => fixture.destroy());

  const attentionVersion = signal(0);

  function show(attention: Partial<SideChatAttention>): void {
    attentionByThread.set('thread-1', {
      parent: { kind: 'session', historyThreadId: 'thread-1', originNodeId: null },
      parentTitle: 'Session', total: 1, running: 0, unread: 0, needsAttention: 0, attentionSince: null, targetChatId: null, ...attention,
    });
    attentionVersion.update((value) => value + 1);
    fixture.componentInstance.instance.set(makeInstance({ historyThreadId: 'thread-1' }));
    fixture.detectChanges();
  }

  function sideChatBadge(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('.side-chat-badge');
  }

  it('shows nothing for a session without sidechats', () => {
    fixture.componentInstance.instance.set(makeInstance({ historyThreadId: 'thread-1' }));
    fixture.detectChanges();

    expect(sideChatBadge()).toBeNull();
  });

  it('ranks needing action over unread and running, with readable labels', () => {
    show({ total: 3, running: 1, unread: 1, needsAttention: 1, targetChatId: 'side-2' });
    expect(sideChatBadge()?.dataset['kind']).toBe('needs-attention');
    expect(sideChatBadge()?.getAttribute('aria-label')).toBe('1 sidechat needs action, open sidechats');

    show({ total: 2, running: 1, unread: 2 });
    expect(sideChatBadge()?.dataset['kind']).toBe('unread');
    expect(sideChatBadge()?.textContent?.trim()).toBe('2');

    show({ total: 1, running: 1 });
    expect(sideChatBadge()?.dataset['kind']).toBe('running');

    show({ total: 2 });
    expect(sideChatBadge()?.dataset['kind']).toBe('quiet');
  });

  it('opens the session\'s sidechats on the conversation needing attention without selecting the row twice', () => {
    show({ total: 1, unread: 1, targetChatId: 'side-5' });
    const rowSelect = vi.fn();
    fixture.debugElement.query((node) => node.componentInstance instanceof InstanceRowComponent)
      .componentInstance.instanceSelect.subscribe(rowSelect);

    sideChatBadge()!.click();

    expect(requestOpen).toHaveBeenCalledWith(
      { kind: 'session', historyThreadId: 'thread-1', originNodeId: null },
      'side-5',
    );
    expect(rowSelect).not.toHaveBeenCalled();
  });
});
