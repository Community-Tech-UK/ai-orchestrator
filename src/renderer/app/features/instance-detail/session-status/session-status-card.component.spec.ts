import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { SessionStatusCardComponent } from './session-status-card.component';
describe('Session status card', () => {
  it('renders rows and copies the same view as plain text', async () => {
    TestBed.configureTestingModule({ imports: [SessionStatusCardComponent] });
    const fixture = TestBed.createComponent(SessionStatusCardComponent);
    const view = { title: 'Session status · Example', rows: [{ label: 'Model', lines: ['Opus · effort high'] }], text: 'Session status · Example\nModel: Opus · effort high' };
    (fixture.componentInstance as unknown as { view: () => typeof view }).view = () => view;
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Opus · effort high');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const copy = [...fixture.nativeElement.querySelectorAll('button')].find((button: HTMLButtonElement) => button.textContent === 'Copy');
    copy.click(); await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(view.text);
  });
});
