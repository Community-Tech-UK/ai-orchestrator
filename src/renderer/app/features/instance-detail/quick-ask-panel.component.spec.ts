import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { QuickAskPanelComponent } from './quick-ask-panel.component';

describe('QuickAskPanelComponent', () => {
  let fixture: ComponentFixture<QuickAskPanelComponent>;
  const quickAsk = vi.fn();

  beforeEach(async () => {
    quickAsk.mockReset();
    await TestBed.configureTestingModule({
      imports: [QuickAskPanelComponent],
      providers: [{ provide: InstanceIpcService, useValue: { quickAsk } }],
    }).compileComponents();
    fixture = TestBed.createComponent(QuickAskPanelComponent);
    fixture.componentRef.setInput('instanceId', 'session-1');
    fixture.componentRef.setInput('contextUsage', { used: 120_000, total: 200_000, percentage: 60, occupancyReported: true });
    fixture.detectChanges();
  });

  it('asks the selected session and keeps the answer in the panel', async () => {
    quickAsk.mockResolvedValue({ success: true, data: { ok: true, answer: 'The summary is ready.' } });
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    input.value = 'What changed?';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(quickAsk).toHaveBeenCalledWith('session-1', 'What changed?');
    expect(fixture.nativeElement.textContent).toContain('The summary is ready.');
    expect(fixture.nativeElement.textContent).toContain('re-reading about 120K tokens');
    expect(fixture.nativeElement.textContent).toContain('not saved to the conversation');
  });

  it('shows a plain failure message and rejects overlong questions', async () => {
    quickAsk.mockResolvedValue({ success: true, data: { ok: false, code: 'busy', message: 'A loop is using this session right now' } });
    const panel = fixture.componentInstance;
    panel.question.set('Question');
    await panel.onAsk();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('A loop is using this session right now');

    panel.question.set('x'.repeat(4_001));
    expect(panel.canAsk()).toBe(false);
    await panel.onAsk();
    expect(quickAsk).toHaveBeenCalledTimes(1);
  });

  it.each([
    { used: 120_000 },
    { used: 120_000, occupancyReported: false },
    { used: 120_000, occupancyReported: true, occupancyIsAggregate: true },
    { used: Number.NaN, occupancyReported: true },
    { used: Number.POSITIVE_INFINITY, occupancyReported: true },
    { used: -120_000, occupancyReported: true },
  ])('keeps the conversation re-read warning without inventing a count for %j', (usage) => {
    fixture.componentRef.setInput('contextUsage', { total: 200_000, percentage: 60, ...usage });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('120K tokens');
    expect(fixture.nativeElement.textContent).not.toContain('Infinity');
    expect(fixture.nativeElement.textContent).not.toContain('NaN');
    expect(fixture.nativeElement.textContent).toContain('re-reads its conversation');
  });
  it('shows the fallback-model notice beside the answer, and no notice for an ordinary answer', async () => {
    const panel = fixture.componentInstance;
    panel.question.set('Question');
    quickAsk.mockResolvedValue({ success: true, data: {
      ok: true, answer: 'Use the staging key.',
      notice: 'This answer came from claude-opus-5-5 because claude-fable-5 declined the question.',
    } });
    await panel.onAsk();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.quick-ask-notice')?.textContent)
      .toContain('claude-opus-5-5 because claude-fable-5 declined');
    expect(fixture.nativeElement.textContent).toContain('Use the staging key.');

    quickAsk.mockResolvedValue({ success: true, data: { ok: true, answer: 'Plain answer' } });
    await panel.onAsk();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.quick-ask-notice')).toBeNull();
  });
});
