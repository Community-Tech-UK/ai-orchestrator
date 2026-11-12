import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { InstanceEventsService } from '../../core/services/instance-events.service';
import { ProviderDiagnosticsPanelComponent } from './provider-diagnostics-panel.component';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';

function makeEnvelope(
  event: ProviderRuntimeEventEnvelope['event'],
  instanceId = 'inst-1',
): ProviderRuntimeEventEnvelope {
  return {
    eventId: `a1b2c3d4-e5f6-4890-abcd-ef01234567${instanceId === 'inst-1' ? '89' : '90'}`,
    seq: 0,
    timestamp: 1_717_000_000_000,
    provider: 'claude',
    instanceId,
    event,
  };
}

describe('ProviderDiagnosticsPanelComponent', () => {
  let events: Subject<ProviderRuntimeEventEnvelope>;
  let fixture: ComponentFixture<ProviderDiagnosticsPanelComponent>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    events = new Subject<ProviderRuntimeEventEnvelope>();

    await TestBed.configureTestingModule({
      imports: [ProviderDiagnosticsPanelComponent],
      providers: [
        {
          provide: InstanceEventsService,
          useValue: { events$: events.asObservable() },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ProviderDiagnosticsPanelComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('contextUsage', {
      used: 80,
      total: 100,
      percentage: 80,
    });
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    TestBed.resetTestingModule();
  });

  /**
   * LT-018. This live-event path is PRIMARY — `withInputContext()`'s gated
   * fallback only fills a gap (`context: snapshot.context ?? ...`), so whatever
   * lands here first wins permanently. An ungated "no reading yet" event
   * therefore pinned a confident "Context: 0%" pill next to a context bar
   * correctly reading "no data".
   */
  it('ignores a context event that carries no real occupancy reading', () => {
    events.next(makeEnvelope({
      kind: 'context',
      used: 0,
      total: 200_000,
      percentage: 0,
      occupancyReported: false,
    }));
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain('Context');
    expect(text).not.toContain('0%');
  });

  it('renders available request, stop, quota, rate-limit, and context diagnostics', () => {
    events.next(makeEnvelope({
      kind: 'error',
      message: 'Rate limited',
      requestId: 'req_123',
      rateLimit: { remaining: 0, resetAt: 1_717_000_060_000 },
    }));
    events.next(makeEnvelope({
      kind: 'complete',
      stopReason: 'end_turn',
      quota: { exhausted: true, message: 'quota exhausted' },
    }));
    events.next(makeEnvelope({
      kind: 'context',
      used: 80,
      total: 100,
      percentage: 80,
      // LT-018: a real provider reading. Ungated events are now ignored here,
      // because this path wins permanently over the gated fallback.
      occupancyReported: true,
      inputTokens: 60,
      outputTokens: 20,
      promptWeight: 0.75,
      promptWeightBreakdown: {
        systemPrompt: 35,
        mcpToolDescriptions: 12,
        skills: 8,
      },
    }));
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('req_123');
    expect(text).toContain('end_turn');
    expect(text).toContain('0 remaining');
    expect(text).toContain('Exhausted');
    expect(text).toContain('80%');
    expect(text).toContain('60 in / 20 out');
    expect(text).toContain('75% prompt');
    expect(text).toContain('system 35');
    expect(text).toContain('MCP tools 12');
    expect(text).toContain('skills 8');
    const details = fixture.nativeElement.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('req_123');
    expect(details.textContent).toContain('end_turn');
    const pills = Array.from(fixture.nativeElement.querySelectorAll('.diagnostic-pill') as NodeListOf<HTMLElement>);
    expect(pills.map((pill) => pill.textContent).join(' ')).not.toMatch(/req_123|end_turn|Request|Stop/);
  });

  it('shows a plain warning for an abnormal stop while keeping the raw reason in Details', () => {
    events.next(makeEnvelope({ kind: 'complete', stopReason: 'max_tokens' }));
    fixture.detectChanges();
    const warning = fixture.nativeElement.querySelector('.diagnostic-pill.warning') as HTMLElement;
    expect(warning.textContent).toContain('Stopped early:');
    expect(warning.textContent).toContain('Output limit reached');
    expect(warning.textContent).not.toContain('max_tokens');
    expect(fixture.nativeElement.querySelector('details').textContent).toContain('max_tokens');
  });

  it.each(['end_turn', 'stop_sequence', 'tool_use'])('keeps a normal %s stop out of the pills', (stopReason) => {
    events.next(makeEnvelope({ kind: 'complete', stopReason }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.diagnostic-pill')).toBeNull();
    expect(fixture.nativeElement.querySelector('details').textContent).toContain(stopReason);
  });

  it('copies the original request id and stop reason from their Details buttons', async () => {
    const copy = vi.spyOn(TestBed.inject(CLIPBOARD_SERVICE), 'copyText').mockResolvedValue({ ok: true });
    events.next(makeEnvelope({ kind: 'complete', requestId: 'req_copy', stopReason: 'max_tokens' }));
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('details button') as NodeListOf<HTMLButtonElement>;
    buttons[0].click();
    buttons[1].click();
    await fixture.whenStable();
    expect(copy.mock.calls).toEqual([
      ['req_copy', { label: 'Request id' }],
      ['max_tokens', { label: 'Stop reason' }],
    ]);
  });

  it('ignores diagnostics from other instances and hides absent fields', () => {
    events.next(makeEnvelope({
      kind: 'complete',
      requestId: 'req_other',
      stopReason: 'stop_other',
    }, 'inst-2'));
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain('req_other');
    expect(text).not.toContain('stop_other');
    expect(text).not.toContain('Request');
  });

  it('clears event diagnostics when switching to another instance', () => {
    events.next(makeEnvelope({
      kind: 'complete',
      requestId: 'req_inst_1',
      stopReason: 'end_turn',
    }));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('req_inst_1');

    fixture.componentRef.setInput('instanceId', 'inst-2');
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain('req_inst_1');
    expect(text).not.toContain('end_turn');
  });
});

/**
 * LT-034. The diagnostics pill is a third surface rendering the same numbers.
 * For an aggregate-only provider `percentage` is cumulative spend, so showing
 * it as "N%" — and styling it `warning` past 90 — repeats the defect the ring
 * and the context bar were fixed for.
 */
describe('ProviderDiagnosticsPanelComponent aggregate occupancy (LT-034)', () => {
  let events: Subject<ProviderRuntimeEventEnvelope>;
  let fixture: ComponentFixture<ProviderDiagnosticsPanelComponent>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    events = new Subject<ProviderRuntimeEventEnvelope>();
    await TestBed.configureTestingModule({
      imports: [ProviderDiagnosticsPanelComponent],
      providers: [
        { provide: InstanceEventsService, useValue: { events$: events.asObservable() } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ProviderDiagnosticsPanelComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    TestBed.resetTestingModule();
  });

  it('renders a token count, not a percentage, for an aggregate-only provider', () => {
    events.next(makeEnvelope({
      kind: 'context',
      used: 190_000,
      total: 200_000,
      percentage: 95,
      occupancyReported: true,
      occupancyIsAggregate: true,
    }));
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('190,000 tokens used');
    expect(text).toContain('no window occupancy');
    expect(text).not.toContain('95%');
  });

  it('still renders a real percentage for a provider reporting occupancy', () => {
    events.next(makeEnvelope({
      kind: 'context',
      used: 160_000,
      total: 200_000,
      percentage: 80,
      occupancyReported: true,
    }));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent as string).toContain('80%');
  });

  it('excludes the context row when asked, because the ring already says it', () => {
    events.next(makeEnvelope({ kind: 'context', used: 160_000, total: 200_000, percentage: 80, occupancyReported: true }));
    events.next(makeEnvelope({ kind: 'complete', rateLimit: { remaining: 3 } }));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent as string).toContain('80%');

    fixture.componentRef.setInput('exclude', ['context']);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).not.toContain('80%');
    expect(text).not.toContain('Context');
    expect(text).toContain('3 remaining');
  });

  it('exposes a warning for exhausted quota and for a spent rate limit, and none otherwise', () => {
    expect(fixture.componentInstance.warningItems()).toEqual([]);
    events.next(makeEnvelope({ kind: 'complete', rateLimit: { remaining: 4 } }));
    fixture.detectChanges();
    expect(fixture.componentInstance.warningItems()).toEqual([]);

    events.next(makeEnvelope({ kind: 'complete', rateLimit: { remaining: 0 } }));
    fixture.detectChanges();
    expect(fixture.componentInstance.warningItems().map(item => item.id)).toEqual(['rate-limit']);

    events.next(makeEnvelope({ kind: 'complete', quota: { exhausted: true, message: 'quota exhausted' } }));
    fixture.detectChanges();
    expect(fixture.componentInstance.warningItems().map(item => item.id)).toEqual(['rate-limit', 'quota']);
  });

  it('keeps an excluded warning visible to the host that asked for the exclusion', () => {
    fixture.componentRef.setInput('exclude', ['context']);
    events.next(makeEnvelope({ kind: 'complete', quota: { exhausted: true, message: 'quota exhausted' } }));
    fixture.detectChanges();
    expect(fixture.componentInstance.warningItems().map(item => item.id)).toEqual(['quota']);
  });
});
