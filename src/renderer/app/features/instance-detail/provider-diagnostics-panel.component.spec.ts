import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { InstanceEventsService } from '../../core/services/instance-events.service';
import { ProviderDiagnosticsPanelComponent } from './provider-diagnostics-panel.component';

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
    fixture.componentInstance.instanceId = 'inst-1';
    fixture.componentInstance.contextUsage = {
      used: 80,
      total: 100,
      percentage: 80,
    };
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    TestBed.resetTestingModule();
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
      inputTokens: 60,
      outputTokens: 20,
      promptWeight: 0.75,
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
});
