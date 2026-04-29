import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TerminalDrawerComponent } from './terminal-drawer.component';

describe('TerminalDrawerComponent', () => {
  it('renders the empty-state placeholder text from the stub error event', async () => {
    TestBed.configureTestingModule({ imports: [TerminalDrawerComponent] });

    const fixture = TestBed.createComponent(TerminalDrawerComponent);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toMatch(/Terminal drawer is not yet implemented/);
  });

  it('emits close when the close button is clicked', () => {
    TestBed.configureTestingModule({ imports: [TerminalDrawerComponent] });

    const fixture = TestBed.createComponent(TerminalDrawerComponent);
    let closed = false;
    fixture.componentInstance.closeRequested.subscribe(() => {
      closed = true;
    });
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      'button[aria-label="Close terminal drawer"]',
    );
    button?.click();

    expect(closed).toBe(true);
  });
});
