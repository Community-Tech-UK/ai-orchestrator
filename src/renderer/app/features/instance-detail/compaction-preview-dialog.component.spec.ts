import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { ToastService } from '../../core/services/toast.service';
import type { CompactionPreview } from '../../../../shared/types/compaction-preview.types';
import { CompactionPreviewDialogComponent } from './compaction-preview-dialog.component';

function makePreview(overrides: Partial<CompactionPreview> = {}): CompactionPreview {
  return {
    mode: 'aio-managed',
    affectedRange: { fromIndex: 0, toIndex: 1, messageCount: 2 },
    keptVerbatimCount: 3,
    tokenEstimate: { value: 42, source: 'heuristic' },
    protectedItems: { mostRecentUserTurnProtected: true, authenticatedEvidencePreserved: false },
    totalMessageCount: 5,
    totalExchangeCount: 3,
    keepLatestExchanges: 1,
    note: null,
    ...overrides,
  };
}

describe('CompactionPreviewDialogComponent', () => {
  let fixture: ComponentFixture<CompactionPreviewDialogComponent>;
  let previewCompaction: ReturnType<typeof vi.fn>;
  let applyCompactionWithOptions: ReturnType<typeof vi.fn>;
  let toastShow: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    previewCompaction = vi.fn(async (_id: string, opts?: { keepLatestExchanges?: number }) => ({
      success: true,
      data: makePreview(opts?.keepLatestExchanges !== undefined ? { keepLatestExchanges: opts.keepLatestExchanges } : {}),
    }));
    applyCompactionWithOptions = vi.fn(async () => ({ success: true }));
    toastShow = vi.fn();

    await TestBed.configureTestingModule({
      imports: [CompactionPreviewDialogComponent],
      providers: [
        { provide: InstanceIpcService, useValue: { previewCompaction, applyCompactionWithOptions } },
        { provide: ToastService, useValue: { show: toastShow } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CompactionPreviewDialogComponent);
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('renders nothing while closed', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cpd-overlay')).toBeNull();
    expect(previewCompaction).not.toHaveBeenCalled();
  });

  it('loads the default (no-boundary) preview when opened and renders its facts', async () => {
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(previewCompaction).toHaveBeenCalledWith('inst-1', { keepLatestExchanges: undefined });
    const facts = fixture.nativeElement.textContent as string;
    expect(facts).toContain('2 message(s)');
    expect(facts).toContain('3 message(s) of 5 total');
    expect(facts).toContain('~42 (heuristic)');
    expect(facts).toContain('Your most recent message stays verbatim');
  });

  it('seeds the keep-latest-exchanges input from the preview default', async () => {
    previewCompaction.mockResolvedValueOnce({ success: true, data: makePreview({ keepLatestExchanges: 2 }) });
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('#cpd-keep-latest') as HTMLInputElement;
    expect(input.value).toBe('2');
  });

  it('re-previews with the new boundary after the debounce elapses when the field changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    previewCompaction.mockClear();
    const input = fixture.nativeElement.querySelector('#cpd-keep-latest') as HTMLInputElement;
    input.value = '2';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    // No re-fetch yet — still debouncing.
    expect(previewCompaction).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(350);
    fixture.detectChanges();

    expect(previewCompaction).toHaveBeenCalledWith('inst-1', { keepLatestExchanges: 2 });
  });

  it('clamps the keep-latest-exchanges input to [0, totalExchangeCount]', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    previewCompaction.mockClear();
    const input = fixture.nativeElement.querySelector('#cpd-keep-latest') as HTMLInputElement;
    input.value = '999';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(350);
    fixture.detectChanges();

    expect(previewCompaction).toHaveBeenCalledWith('inst-1', { keepLatestExchanges: 3 }); // totalExchangeCount from makePreview()
  });

  it('confirming applies the current boundary and emits closed on success', async () => {
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    let closedCount = 0;
    fixture.componentInstance.closed.subscribe(() => { closedCount += 1; });

    const confirmBtn = [...fixture.nativeElement.querySelectorAll('.cpd-btn')]
      .find((btn) => (btn as HTMLElement).textContent?.trim() === 'Confirm') as HTMLButtonElement;
    confirmBtn.click();
    await fixture.whenStable();

    expect(applyCompactionWithOptions).toHaveBeenCalledWith('inst-1', { keepLatestExchanges: 1 });
    expect(closedCount).toBe(1);
    expect(toastShow).toHaveBeenCalledWith('Compaction complete.', 'success');
  });

  it('confirming shows an error toast and does NOT close on failure', async () => {
    applyCompactionWithOptions.mockResolvedValueOnce({ success: false, error: { message: 'boom' } });
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    let closedCount = 0;
    fixture.componentInstance.closed.subscribe(() => { closedCount += 1; });

    const confirmBtn = [...fixture.nativeElement.querySelectorAll('.cpd-btn')]
      .find((btn) => (btn as HTMLElement).textContent?.trim() === 'Confirm') as HTMLButtonElement;
    confirmBtn.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(closedCount).toBe(0);
    expect(toastShow).toHaveBeenCalledWith('boom', 'error');
    expect(fixture.nativeElement.textContent).toContain('boom');
  });

  it('cancel emits closed without calling apply', async () => {
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    let closedCount = 0;
    fixture.componentInstance.closed.subscribe(() => { closedCount += 1; });

    const cancelBtn = [...fixture.nativeElement.querySelectorAll('.cpd-btn')]
      .find((btn) => (btn as HTMLElement).textContent?.trim() === 'Cancel') as HTMLButtonElement;
    cancelBtn.click();

    expect(closedCount).toBe(1);
    expect(applyCompactionWithOptions).not.toHaveBeenCalled();
  });

  it('shows the honest note and no boundary control for adapter-self-managed providers', async () => {
    previewCompaction.mockResolvedValueOnce({
      success: true,
      data: makePreview({
        mode: 'adapter-self-managed',
        affectedRange: { fromIndex: 0, toIndex: -1, messageCount: 0 },
        note: 'This provider manages context compaction internally.',
      }),
    });
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('manages context compaction internally');
    expect(fixture.nativeElement.querySelector('#cpd-keep-latest')).toBeNull();
  });

  it('shows an honest unavailable note when the instance no longer exists', async () => {
    previewCompaction.mockResolvedValueOnce({
      success: true,
      data: makePreview({ mode: 'unavailable', note: 'This instance no longer exists.' }),
    });
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('This instance no longer exists.');
  });

  it('Escape key cancels', async () => {
    fixture.componentRef.setInput('instanceId', 'inst-1');
    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    let closedCount = 0;
    fixture.componentInstance.closed.subscribe(() => { closedCount += 1; });

    const overlay = fixture.nativeElement.querySelector('.cpd-overlay') as HTMLElement;
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(closedCount).toBe(1);
  });
});
