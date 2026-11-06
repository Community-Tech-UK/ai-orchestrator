import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EditFailureWarning, TurnSummary } from '../../../../shared/summarise-turn';
import { TurnSummaryRowComponent } from './turn-summary-row.component';

const summary: TurnSummary = {
  text: '12 s · edited 2 files +18 −3 · ran 3 commands · 1 failed',
  duration: '12 s',
  failed: 1,
  segments: [
    { kind: 'edited', text: 'edited 2 files +18 −3', count: 2 },
    { kind: 'ran', text: 'ran 3 commands', count: 3 },
    { kind: 'failed', text: '1 failed', count: 1 },
  ],
};

const warning: EditFailureWarning = {
  text: '1 edit failed and was not retried: src/a.ts (the file was not found). Check before trusting the summary.',
  count: 1,
  items: [{ path: 'src/a.ts', reason: 'the file was not found', detail: 'ENOENT: no such file', retried: false }],
};

describe('TurnSummaryRowComponent', () => {
  let fixture: ComponentFixture<TurnSummaryRowComponent>;
  let host: HTMLElement;
  const reviews: number[] = [];

  async function render(inputs: {
    summary?: TurnSummary | null;
    warning?: EditFailureWarning | null;
    changedFiles?: number;
    /** Defaults to true here, because most of these tests are about the button. */
    reviewable?: boolean;
  }): Promise<void> {
    fixture.componentRef.setInput('summary', inputs.summary ?? null);
    fixture.componentRef.setInput('warning', inputs.warning ?? null);
    fixture.componentRef.setInput('changedFiles', inputs.changedFiles ?? 0);
    fixture.componentRef.setInput('reviewable', inputs.reviewable ?? true);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    reviews.length = 0;
    await TestBed.configureTestingModule({ imports: [TurnSummaryRowComponent] }).compileComponents();
    fixture = TestBed.createComponent(TurnSummaryRowComponent);
    fixture.componentInstance.reviewRequested.subscribe(() => reviews.push(1));
    host = fixture.nativeElement as HTMLElement;
  });

  it('renders nothing when there is nothing to say', async () => {
    await render({});
    expect(host.querySelector('.turn-note')).toBeNull();
  });

  it('writes the summary line with its failure count marked', async () => {
    await render({ summary });
    const line = host.querySelector('.turn-line') as HTMLElement;
    expect(line.textContent?.replace(/\s+/g, ' ').trim()).toContain('12 s');
    expect(line.textContent).toContain('edited 2 files +18 −3');
    expect(line.textContent).toContain('ran 3 commands');
    const failed = line.querySelector('.failed') as HTMLElement;
    expect(failed.textContent?.trim()).toBe('1 failed');
  });

  it('does not start with a separator when the turn had no time to show', async () => {
    await render({ summary: { ...summary, duration: '', text: 'ran 1 command', segments: [summary.segments[1]], failed: 0 } });
    const first = host.querySelector('.turn-line')!.firstElementChild as HTMLElement;
    expect(first.classList.contains('sep')).toBe(false);
    expect(first.textContent?.trim()).toBe('ran 3 commands');
  });

  it('offers a Changed N files button only when files changed, and says it plainly', async () => {
    await render({ summary, changedFiles: 0 });
    expect(host.querySelector('button.changed-btn')).toBeNull();

    await render({ summary, changedFiles: 4 });
    const button = host.querySelector('button.changed-btn') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('Changed 4 files while this reply ran');

    await render({ summary, changedFiles: 1 });
    expect(host.querySelector('button.changed-btn')!.textContent?.trim()).toBe('Changed 1 file while this reply ran');
  });

  it('asks for the review panel when the button is pressed', async () => {
    await render({ summary, changedFiles: 2 });
    (host.querySelector('button.changed-btn') as HTMLButtonElement).click();
    expect(reviews).toHaveLength(1);
  });

  it('shows the count as plain text, not a dead button, when the host has no review panel to open', async () => {
    await render({ summary, changedFiles: 4, reviewable: false });
    expect(host.querySelector('button.changed-btn')).toBeNull();
    expect(host.querySelector('.changed-line')?.textContent?.trim()).toBe('Changed 4 files while this reply ran');
    expect(reviews).toHaveLength(0);
  });

  it('does not offer a review panel by default', () => {
    expect(fixture.componentInstance.reviewable()).toBe(false);
  });

  it('shows the Changed button even when the turn had no summary line', async () => {
    await render({ summary: null, changedFiles: 3 });
    expect(host.querySelector('.turn-line')).toBeNull();
    expect(host.querySelector('button.changed-btn')).toBeTruthy();
  });

  it('shows the failed-edit warning and keeps the raw tool text behind Details', async () => {
    await render({ summary, warning });
    const text = host.querySelector('.turn-warning')!.textContent ?? '';
    expect(text).toContain('1 edit failed and was not retried: src/a.ts (the file was not found).');
    expect(text).toContain('Check before trusting the summary.');
    expect(text).not.toContain('ENOENT');
    expect(host.querySelector('.warning-details')).toBeNull();

    const details = host.querySelector('button.details-btn') as HTMLButtonElement;
    expect(details.getAttribute('aria-expanded')).toBe('false');
    details.click();
    fixture.detectChanges();
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.warning-details')!.textContent).toContain('src/a.ts');
    expect(host.querySelector('.warning-details')!.textContent).toContain('ENOENT: no such file');

    details.click();
    fixture.detectChanges();
    expect(host.querySelector('.warning-details')).toBeNull();
  });

  it('names the warning for screen readers', async () => {
    await render({ warning });
    expect(host.querySelector('.turn-warning .sr-only')!.textContent).toContain('Warning');
  });

  it('shows raw tool text as plain text, never as markup', async () => {
    await render({
      warning: { ...warning, items: [{ ...warning.items[0], detail: '<img src=x onerror=alert(1)>' }] },
    });
    (host.querySelector('button.details-btn') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('.warning-details img')).toBeNull();
    expect(host.querySelector('.warning-details')!.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('says so when the tool gave no details or no file name', async () => {
    await render({ warning: { ...warning, items: [{ reason: 'the tool reported an error', detail: '', retried: false }] } });
    (host.querySelector('button.details-btn') as HTMLButtonElement).click();
    fixture.detectChanges();
    const details = host.querySelector('.warning-details')!.textContent ?? '';
    expect(details).toContain('File not named');
    expect(details).toContain('The tool gave no details.');
  });

  it('uses no native title attribute', async () => {
    await render({ summary, warning, changedFiles: 2 });
    expect(host.querySelector('[title]')).toBeNull();
  });
});
