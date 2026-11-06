import { Component, input, output, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';
import { USAGE_CAUSE_COPY } from '../../../../shared/usage-insight/usage-cause-copy';
import type { UsageCauseId, UsageInsightResponse } from '../../../../shared/usage-insight/usage-insight.types';
import { UsageInsightIpcService } from '../../core/services/ipc/usage-insight-ipc.service';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';
import { InstanceStore } from '../../core/state/instance';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { reportWith } from './usage-insight.test-helpers';
import { UsageWhereWentCardComponent } from './usage-where-went-card.component';

@Component({
  selector: 'app-compaction-preview-dialog',
  standalone: true,
  template: '<div data-testid="compaction-dialog" [attr.data-open]="isOpen()" [attr.data-instance]="instanceId()"></div>',
})
class StubCompactionDialog {
  readonly instanceId = input<string | null>(null);
  readonly isOpen = input(false);
  readonly closed = output<void>();
}

@Component({
  selector: 'app-context-attribution-panel',
  standalone: true,
  template: '<div data-testid="context-panel" [attr.data-instance]="instanceId()"></div>',
})
class StubContextPanel {
  readonly instanceId = input.required<string>();
}

const ALL_SHOWN = {
  cacheMiss: 20, longContext: 21, helperHeavy: 22, parallelSessions: 23, longRunning: 24,
  maxEffort: 25, workflows: 26, alwaysOnContext: 27, bigToolResults: 28,
} as const;

const ready = (report = reportWith(ALL_SHOWN), refreshing = false, extra: Record<string, unknown> = {}): UsageInsightResponse =>
  ({ status: 'ready', report, refreshing, ...extra }) as UsageInsightResponse;

/** A report in which one cause is at `percent` and every other cause is at 0%. */
const only = (id: UsageCauseId, percent: number) => reportWith({ [id]: percent } as Partial<Record<UsageCauseId, number>>);

function claudeInstance(id: string, displayName: string, provider = 'claude') {
  return { id, displayName, provider };
}

describe('UsageWhereWentCardComponent', () => {
  const get = vi.fn();
  const navigate = vi.fn().mockResolvedValue(true);
  const instancesMap = signal(new Map<string, unknown>());
  const selectedInstance = signal<unknown>(null);
  const snapshots = signal<Record<string, ProviderQuotaSnapshot | null>>({ claude: null });
  const accountSnapshots = signal<ProviderQuotaSnapshot[]>([]);
  let fixture: ComponentFixture<UsageWhereWentCardComponent>;

  beforeEach(() => {
    get.mockReset();
    navigate.mockClear();
    instancesMap.set(new Map());
    selectedInstance.set(null);
    snapshots.set({ claude: null });
    accountSnapshots.set([]);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: UsageInsightIpcService, useValue: { get } },
        { provide: RendererPollSchedulerService, useValue: { register: () => () => undefined } },
        { provide: InstanceStore, useValue: { instancesMap, selectedInstance } },
        { provide: ProviderQuotaStore, useValue: { snapshots, accountSnapshots } },
        { provide: Router, useValue: { navigate } },
      ],
    });
    TestBed.overrideComponent(UsageWhereWentCardComponent, {
      set: { imports: [AioTooltipDirective, StubCompactionDialog, StubContextPanel] },
    });
  });

  async function render(response: UsageInsightResponse | Promise<UsageInsightResponse>, instanceId?: string) {
    get.mockImplementation(async () => ({ success: true, data: await response }));
    fixture = TestBed.createComponent(UsageWhereWentCardComponent);
    if (instanceId) fixture.componentRef.setInput('instanceId', instanceId);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const text = (root: HTMLElement) => (root.textContent ?? '').replace(/\s+/g, ' ');
  const button = (root: HTMLElement, label: string) =>
    Array.from(root.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === label) ?? null;
  const row = (root: HTMLElement, id: string) => root.querySelector(`[data-cause="${id}"]`);
  const click = (target: HTMLElement | null) => { target!.click(); fixture.detectChanges(); };

  describe('while it works', () => {
    it('says it is reading before the first answer arrives', () => {
      get.mockReturnValue(new Promise(() => undefined));
      fixture = TestBed.createComponent(UsageWhereWentCardComponent);
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector('[data-testid="usage-loading"]')?.textContent).toContain('Reading your Claude records');
      expect(root.querySelector('[data-testid="usage-causes"]')).toBeNull();
      expect((button(root, 'Refresh') as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows how far the reading has got', async () => {
      const root = await render({ status: 'scanning', progress: { filesDone: 3, filesTotal: 12, bytesDone: 25, bytesTotal: 100 } });
      expect(text(root)).toContain('Reading your Claude records: 3 of 12 files.');
      const bar = root.querySelector('[role="progressbar"]')!;
      expect(bar.getAttribute('aria-valuenow')).toBe('25');
      expect((button(root, 'Refresh') as HTMLButtonElement).disabled).toBe(true);
    });

    it('keeps the old report on screen and says it is updating', async () => {
      const root = await render(ready(reportWith({ cacheMiss: 30 }), true));
      expect(root.querySelector('[data-testid="usage-refreshing"]')?.textContent).toContain('Updating from your latest records');
      expect(row(root, 'cacheMiss')).not.toBeNull();
      expect((button(root, 'Refresh') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('the causes', () => {
    it('shows only causes at 10% or more, percentage first, in the plan order', async () => {
      const root = await render(ready(reportWith({ bigToolResults: 40, cacheMiss: 12, longContext: 9, parallelSessions: 55 })));
      const rows = Array.from(root.querySelectorAll('li.uwc-row'));
      expect(rows.map((entry) => entry.getAttribute('data-cause'))).toEqual(['cacheMiss', 'parallelSessions', 'bigToolResults']);
      expect(rows.map((entry) => entry.querySelector('.uwc-pct')?.textContent?.trim())).toEqual(['12%', '55%', '40%']);
      expect(text(root)).not.toContain(USAGE_CAUSE_COPY.longContext.title);
    });

    it('leaves out a cause at 9.5% even though its label would round up to 10%', async () => {
      const root = await render(ready(reportWith({ cacheMiss: 9.5, longContext: 9.95, helperHeavy: 10 })));
      expect(row(root, 'cacheMiss')).toBeNull();
      expect(row(root, 'longContext')).toBeNull();
      expect(row(root, 'helperHeavy')!.querySelector('.uwc-pct')?.textContent?.trim()).toBe('10%');
    });

    it('gives each shown cause its title, what it is a share of, and one sentence', async () => {
      const root = await render(ready(reportWith({ cacheMiss: 12 })));
      const first = row(root, 'cacheMiss')!;
      expect(first.querySelector('.uwc-row-title')?.textContent).toBe(USAGE_CAUSE_COPY.cacheMiss.title);
      expect(first.querySelector('.uwc-share')?.textContent).toBe('12% of your usage in the last 7 days');
      expect(first.querySelector('.uwc-sentence')?.textContent).toBe(USAGE_CAUSE_COPY.cacheMiss.sentence);
    });

    it('says "at least" when only a lower bound is known', async () => {
      const root = await render(ready(reportWith({ maxEffort: 12 }, {}, { maxEffort: { atLeast: true } })));
      expect(row(root, 'maxEffort')!.querySelector('.uwc-share')?.textContent).toBe('At least 12% of your usage in the last 7 days');
    });

    it('says what is a share of the session on a session card', async () => {
      const root = await render(ready(reportWith({ longContext: 100, cacheMiss: 41 }, { scope: { kind: 'session', instanceId: 'inst-1' } })), 'inst-1');
      expect(row(root, 'longContext')!.querySelector('.uwc-share')?.textContent).toBe("All of this session's usage");
      expect(row(root, 'cacheMiss')!.querySelector('.uwc-share')?.textContent).toBe("41% of this session's usage");
      expect(text(root)).toContain('This session, last 7 days');
    });

    it('reminds the reader that the shares overlap', async () => {
      const root = await render(ready(reportWith({ cacheMiss: 50, longContext: 50 })));
      expect(text(root)).toContain("These overlap, so they don't add up to 100%.");
    });

    it('says the shares follow API prices, beside the figures, without opening anything', async () => {
      const root = await render(ready(reportWith({ cacheMiss: 50 })));
      const note = root.querySelector('[data-testid="usage-overlap-note"]')!;
      expect(note.textContent).toContain("isn't how Anthropic counts it");
      expect(note.closest('details')).toBeNull();
    });

    describe('estimates', () => {
      it.each(['parallelSessions', 'longRunning', 'bigToolResults'] as const)('marks %s as an estimate', async (id) => {
        const root = await render(ready(only(id, 23)));
        expect(row(root, id)!.querySelector('.uwc-share')?.textContent).toBe('23% of your usage in the last 7 days (estimate)');
        expect(USAGE_CAUSE_COPY[id].measure).toMatch(/estimate/i);
      });

      it.each(['cacheMiss', 'longContext', 'helperHeavy', 'alwaysOnContext', 'maxEffort', 'workflows'] as const)(
        'does not mark %s as an estimate',
        async (id) => {
          const root = await render(ready(only(id, 23)));
          expect(row(root, id)!.querySelector('.uwc-share')?.textContent).not.toContain('estimate');
        },
      );

      it('keeps "at least" and "estimate" apart: a lower bound is not called an estimate', async () => {
        const root = await render(ready(reportWith({ maxEffort: 12 }, {}, { maxEffort: { atLeast: true } })));
        expect(row(root, 'maxEffort')!.querySelector('.uwc-share')?.textContent).toBe('At least 12% of your usage in the last 7 days');
      });

      it('explains how each estimate was made, behind "How this was worked out"', async () => {
        const root = await render(ready(reportWith({ parallelSessions: 30 })));
        const how = root.querySelector('details.uwc-how')!;
        expect(how.querySelector('[data-testid="usage-estimates"]')?.textContent).toContain('five minutes');
        expect(how.querySelector('[data-testid="usage-estimates"]')?.textContent).toContain('30 minutes');
        expect(how.querySelector('[data-testid="usage-estimates"]')?.textContent).toContain('four characters');
      });
    });

    describe('what the figures cover', () => {
      it('says so in view: this computer only, other computers and the Claude apps left out', async () => {
        const root = await render(ready(reportWith({ cacheMiss: 30 })));
        const coverage = root.querySelector('[data-testid="usage-coverage"]')!;
        expect(coverage.closest('details')).toBeNull();
        expect(coverage.textContent).toContain('recorded on this computer');
        expect(coverage.textContent).toContain("Usage from other computers or the Claude apps isn't included.");
      });

      it('also says it when nothing stands out', async () => {
        const root = await render(ready(reportWith({ cacheMiss: 3 })));
        expect(root.querySelector('[data-testid="usage-quiet"]')).not.toBeNull();
        expect(root.querySelector('[data-testid="usage-coverage"]')).not.toBeNull();
      });

      it('says how little is known about usage from outside Harness', async () => {
        const report = reportWith({ cacheMiss: 30 }, { coverage: { effortKnown: 0.3, harnessLinked: 0.3 } });
        const root = await render(ready(report));
        expect(root.querySelector('[data-testid="usage-coverage"]')?.textContent).toContain('Only 30% of this usage is from sessions Harness started');
      });

      it("describes a session card by its own records", async () => {
        const report = reportWith({ cacheMiss: 30 }, {
          scope: { kind: 'session', instanceId: 'a' }, totals: { requests: 80, sessions: 1, harnessSessions: 1 },
        });
        const root = await render(ready(report), 'a');
        expect(root.querySelector('[data-testid="usage-coverage"]')?.textContent).toContain('for this session, including helper agents working inside it');
      });

      it('says nothing when there was no usage to cover', async () => {
        const empty = reportWith({}, { totals: { requests: 0, sessions: 0, harnessSessions: 0 } });
        expect((await render(ready(empty))).querySelector('[data-testid="usage-coverage"]')).toBeNull();
      });
    });

    it('uses no native title attributes', async () => {
      const root = await render(ready());
      expect(root.querySelectorAll('[title]')).toHaveLength(0);
    });

    it('makes the percentage focusable so its explanation can be reached from the keyboard', async () => {
      const root = await render(ready(reportWith({ cacheMiss: 12 })));
      expect(root.querySelector('.uwc-pct')?.getAttribute('tabindex')).toBe('0');
    });
  });

  describe('when there is nothing to show', () => {
    it('says nothing stands out when every cause is under 10%', async () => {
      const root = await render(ready(reportWith({ cacheMiss: 9, longContext: 3 })));
      expect(root.querySelector('[data-testid="usage-quiet"]')?.textContent).toContain('Nothing stands out');
    });

    it('says there was no usage', async () => {
      const empty = reportWith({}, { totals: { requests: 0, sessions: 0, harnessSessions: 0 } });
      expect(text(await render(ready(empty)))).toContain('No Claude usage found in the last 7 days.');
    });

    it('explains what could not be read, so "no usage" is not mistaken for "nothing there"', async () => {
      const empty = reportWith({}, {
        totals: { requests: 0, sessions: 0, harnessSessions: 0 },
        notes: [{ code: 'files-unreadable', count: 3 }, { code: 'no-claude-usage' }],
      });
      const root = await render(ready(empty));
      const notes = root.querySelector('[data-testid="usage-empty-notes"]')!;
      expect(notes.textContent).toContain("3 transcripts couldn't be read, so their usage is missing.");
      // The card's own empty message already says there was no usage.
      expect(notes.textContent).not.toContain('No Claude usage was found');
    });

    it('shows no notes list when there is simply no usage', async () => {
      const empty = reportWith({}, { totals: { requests: 0, sessions: 0, harnessSessions: 0 }, notes: [{ code: 'no-claude-usage' }] });
      expect((await render(ready(empty))).querySelector('[data-testid="usage-empty-notes"]')).toBeNull();
    });

    it('says there was no usage from this session', async () => {
      const empty = reportWith({}, { scope: { kind: 'session', instanceId: 'a' }, totals: { requests: 0, sessions: 0, harnessSessions: 0 } });
      expect(text(await render(ready(empty), 'a'))).toContain('No Claude usage from this session in the last 7 days.');
    });

    it('does not hide causes it could not measure', async () => {
      const root = await render(ready(reportWith({ cacheMiss: 15, maxEffort: null, workflows: null })));
      expect(root.querySelector('[data-testid="usage-unmeasured"]')?.textContent?.replace(/\s+/g, ' ')).toContain(
        "Not measured yet: Max effort and Workflows. Harness hasn't recorded the effort setting for this usage.",
      );
    });

    it('explains that the session cannot be broken down', async () => {
      const root = await render({ status: 'unsupported', reason: 'not-claude' }, 'inst-codex');
      expect(root.querySelector('[data-testid="usage-unsupported"]')?.textContent).toContain('only available for Claude sessions');
    });

    it('explains that a session on another computer keeps its records there', async () => {
      const root = await render({ status: 'unsupported', reason: 'remote' }, 'inst-far');
      expect(root.querySelector('[data-testid="usage-unsupported"]')?.textContent)
        .toBe("This session runs on another computer, so its Claude records aren't stored here.");
    });

    it('says the overall card covers the sessions on this computer', async () => {
      expect(text(await render(ready(reportWith({ cacheMiss: 30 }))))).toContain('Claude sessions on this computer, last 7 days');
    });
  });

  describe('when it goes wrong', () => {
    const RAW = "EACCES: permission denied, scandir '/Users/someone/.claude/projects'";

    /** Every piece of text that is on show, which means everything outside a closed Details block. */
    const visibleText = (root: HTMLElement): string => {
      const copy = root.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('details:not([open])').forEach((details) => {
        details.querySelectorAll(':scope > :not(summary)').forEach((child) => child.remove());
      });
      return (copy.textContent ?? '').replace(/\s+/g, ' ');
    };

    it('says what happened in plain words, keeps the raw error behind Details, and lets the reader try again', async () => {
      const root = await render({ status: 'error', message: RAW });
      const error = root.querySelector('[data-testid="usage-error"]')!;
      expect(error.querySelector('[data-testid="usage-error-headline"]')?.textContent).toBe("Harness couldn't work out where your usage went.");
      expect(error.textContent).toContain('What to do: Check Details, then try again.');
      const details = error.querySelector('details')!;
      expect(details.querySelector('summary')?.textContent).toBe('Details');
      expect(details.open).toBe(false);
      expect(details.textContent).toContain(RAW);
      get.mockClear();
      click(button(root, 'Try again'));
      expect(get).toHaveBeenCalledWith({ refresh: true });
    });

    it('shows none of the raw error outside a closed Details block', async () => {
      const root = await render({ status: 'error', message: RAW });
      expect(visibleText(root)).not.toMatch(/EACCES|scandir|\/Users|projects/);
      expect(root.textContent).toContain('EACCES');
    });

    it('words a failed request the same way, with its raw text kept behind Details', async () => {
      get.mockImplementation(async () => ({ success: false, error: { message: RAW } }));
      fixture = TestBed.createComponent(UsageWhereWentCardComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector('[data-testid="usage-error-headline"]')?.textContent).toBe("Harness couldn't work out where your usage went.");
      expect(visibleText(root)).not.toContain('EACCES');
      expect(root.querySelector('[data-testid="usage-error-detail"]')?.textContent).toBe(RAW);
    });

    it('says so when there is no answer at all', async () => {
      get.mockImplementation(async () => ({ success: true }));
      fixture = TestBed.createComponent(UsageWhereWentCardComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector('[data-testid="usage-error-headline"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="usage-error-detail"]')?.textContent).toBe('No answer from Harness.');
    });

    it('leaves out the Details block when there is no raw text to show', async () => {
      get.mockRejectedValue(null);
      fixture = TestBed.createComponent(UsageWhereWentCardComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector('[data-testid="usage-error-headline"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="usage-error"] details')).toBeNull();
    });

    it('shows a failed update beside the previous report, with the raw error behind Details', async () => {
      const root = await render(ready(reportWith({ cacheMiss: 30 }), false, { refreshError: RAW }));
      const line = root.querySelector('[data-testid="usage-refresh-error"]')!;
      expect(line.querySelector(':scope > span')?.textContent)
        .toBe("Couldn't update just now. This is the previous result. What to do: Check Details, then try again.");
      expect(line.querySelector('details')?.textContent).toContain(RAW);
      expect(line.querySelector('details')?.open).toBe(false);
      expect(visibleText(root)).not.toMatch(/EACCES|scandir|\/Users/);
      expect(row(root, 'cacheMiss')).not.toBeNull();
    });
  });

  describe('asking again', () => {
    it('reads the records again when Refresh is pressed', async () => {
      const root = await render(ready(reportWith({ cacheMiss: 30 })));
      expect((button(root, 'Refresh') as HTMLButtonElement).disabled).toBe(false);
      get.mockClear();
      click(button(root, 'Refresh'));
      expect(get).toHaveBeenCalledWith({ refresh: true });
    });

    it('asks about the new session when the card is pointed at another one', async () => {
      await render(ready(reportWith({ cacheMiss: 30 })), 'inst-1');
      expect(get).toHaveBeenLastCalledWith({ instanceId: 'inst-1' });
      fixture.componentRef.setInput('instanceId', 'inst-2');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(get).toHaveBeenLastCalledWith({ instanceId: 'inst-2' });
    });
  });

  describe('plan window', () => {
    const weekly = (used: number): ProviderQuotaSnapshot => ({
      provider: 'claude', takenAt: 1, source: 'admin-api', ok: true,
      windows: [{ kind: 'weekly', id: 'claude.weekly', label: 'Weekly', unit: 'percent', used, limit: 100, remaining: 100 - used, resetsAt: null }],
    } as unknown as ProviderQuotaSnapshot);

    it('leads with the Claude weekly allowance on the Costs page', async () => {
      snapshots.set({ claude: weekly(62) });
      const root = await render(ready(reportWith({ cacheMiss: 30 })));
      expect(root.querySelector('[data-testid="usage-plan-window"]')?.textContent).toBe('Claude weekly allowance: 62% used.');
    });

    it('takes the busiest account when several are signed in', async () => {
      snapshots.set({ claude: weekly(30) });
      accountSnapshots.set([weekly(91)]);
      const root = await render(ready(reportWith({ cacheMiss: 30 })));
      expect(root.querySelector('[data-testid="usage-plan-window"]')?.textContent).toContain('91% used');
    });

    it('shows no plan line when there is no good reading', async () => {
      expect((await render(ready())).querySelector('[data-testid="usage-plan-window"]')).toBeNull();
    });

    it('does not show an account-wide figure on a single session', async () => {
      snapshots.set({ claude: weekly(62) });
      const root = await render(ready(reportWith({ cacheMiss: 30 }, { scope: { kind: 'session', instanceId: 'a' } })), 'a');
      expect(root.querySelector('[data-testid="usage-plan-window"]')).toBeNull();
    });
  });

  describe('how it was worked out', () => {
    it('lists the figures and anything that was left out', async () => {
      const report = reportWith({ cacheMiss: 30 }, { notes: [{ code: 'files-skipped-large', count: 2 }] });
      const root = await render(ready(report));
      const how = root.querySelector('details')!;
      expect(how.textContent?.replace(/\s+/g, ' ')).toContain('Based on 1,200 requests across 14 sessions (9 started by Harness).');
      expect(how.textContent).toContain('2 very large transcripts were left out to keep this quick.');
    });
  });

  describe('buttons', () => {
    it('opens the Settings tab that holds the chat size cap', async () => {
      const root = await render(ready());
      click(button(root, 'Chat size cap'));
      expect(navigate).toHaveBeenCalledWith(['/settings'], { queryParams: { tab: 'memory' } });
    });

    it('opens the helper settings', async () => {
      const root = await render(ready());
      click(button(root, 'Helper settings'));
      expect(navigate).toHaveBeenCalledWith(['/settings'], { queryParams: { tab: 'orchestration' } });
    });

    it('opens the scheduled jobs', async () => {
      const root = await render(ready());
      click(button(root, 'Scheduled jobs'));
      expect(navigate).toHaveBeenCalledWith(['/automations']);
    });

    it.each(['parallelSessions', 'maxEffort', 'workflows', 'bigToolResults'])('gives %s a sentence only', async (id) => {
      const root = await render(ready());
      expect(row(root, id)!.querySelector('button')).toBeNull();
    });

    describe('Compact first', () => {
      it('opens the compaction preview for the session on a session card', async () => {
        instancesMap.set(new Map([['inst-1', claudeInstance('inst-1', 'Fix login')]]));
        const root = await render(ready(reportWith(ALL_SHOWN, { scope: { kind: 'session', instanceId: 'inst-1' } })), 'inst-1');
        const dialog = () => root.querySelector('[data-testid="compaction-dialog"]')!;
        expect(dialog().getAttribute('data-open')).toBe('false');
        click(button(root, 'Compact first'));
        expect(dialog().getAttribute('data-open')).toBe('true');
        expect(dialog().getAttribute('data-instance')).toBe('inst-1');
        fixture.debugElement.query(By.directive(StubCompactionDialog)).componentInstance.closed.emit();
        fixture.detectChanges();
        expect(dialog().getAttribute('data-open')).toBe('false');
      });

      it('names the selected Claude session on the Costs page', async () => {
        selectedInstance.set(claudeInstance('inst-9', 'Fix login'));
        const root = await render(ready());
        click(button(root, 'Compact "Fix login" first'));
        expect(root.querySelector('[data-testid="compaction-dialog"]')!.getAttribute('data-instance')).toBe('inst-9');
      });

      it.each([
        ['no session is selected', null],
        ['the selected session is not Claude', claudeInstance('inst-3', 'Review', 'codex')],
      ])('has no button when %s', async (_name, selected) => {
        selectedInstance.set(selected);
        const root = await render(ready());
        expect(row(root, 'cacheMiss')!.querySelector('button')).toBeNull();
      });

      it('closes the preview when the card is pointed at another session', async () => {
        instancesMap.set(new Map([['inst-1', claudeInstance('inst-1', 'A')], ['inst-2', claudeInstance('inst-2', 'B')]]));
        const root = await render(ready(), 'inst-1');
        click(button(root, 'Compact first'));
        fixture.componentRef.setInput('instanceId', 'inst-2');
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();
        expect(root.querySelector('[data-testid="compaction-dialog"]')!.getAttribute('data-open')).toBe('false');
      });
    });

    describe('Context details', () => {
      it('shows the session\'s context details under the list and closes them again', async () => {
        instancesMap.set(new Map([['inst-1', claudeInstance('inst-1', 'Fix login')]]));
        const root = await render(ready(), 'inst-1');
        expect(root.querySelector('[data-testid="context-panel"]')).toBeNull();
        click(button(root, 'Context details'));
        expect(root.querySelector('[data-testid="context-panel"]')!.getAttribute('data-instance')).toBe('inst-1');
        click(button(root, 'Close'));
        expect(root.querySelector('[data-testid="context-panel"]')).toBeNull();
      });

      it('names the selected session on the Costs page', async () => {
        selectedInstance.set(claudeInstance('inst-9', 'Fix login'));
        const root = await render(ready());
        click(button(root, 'Context details for "Fix login"'));
        expect(root.querySelector('[data-testid="context-panel"]')!.getAttribute('data-instance')).toBe('inst-9');
      });
    });
  });
});
