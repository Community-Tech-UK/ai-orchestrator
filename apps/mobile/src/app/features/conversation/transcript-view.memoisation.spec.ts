import { readFileSync } from 'node:fs';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { marked } from 'marked';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptViewComponent } from './transcript-view.component';
import type { MobileMessageDto } from '../../core/models';

await resolveComponentResources(url => Promise.resolve(readFileSync(new URL(url, import.meta.url), 'utf8')));
const messages: MobileMessageDto[] = Array.from({ length: 1000 }, (_, index) => ({
  id: `message-${index}`, timestamp: 0, seq: index, type: 'assistant', content: `Message **${index}**`,
}));

async function setup(initialMessages = messages) {
  TestBed.configureTestingModule({ imports: [TranscriptViewComponent] });
  const fixture = TestBed.createComponent(TranscriptViewComponent);
  fixture.componentRef.setInput('messages', initialMessages);
  fixture.componentRef.setInput('state', { status: 'loaded', error: null });
  fixture.componentRef.setInput('emptyText', 'Empty');
  await fixture.whenStable();
  return fixture;
}

// This fixture renders the full 1000-item transcript through Angular's
// [innerHTML] sanitiser, whose per-call cost grows with cumulative renders in
// jsdom. A dedicated file (its own test process) stops earlier tests slowing it
// — do not fold it back into the windowing suite. Even alone each page costs
// more than the last: 3 s on a quiet machine, 21-73 s measured at load ~55 on
// 18 cores, hence the larger budget. The contract is the parse count, not speed.
// Cause: jsdom 27.4 builds a selector engine in every Document that adds window
// listeners it never removes, so each new document costs more than the last.
// jsdom 29+ builds it lazily; after that upgrade this can rejoin the windowing
// suite with its 60 s budget.
describe('Windowed memoised transcript', () => {
  it('parses each of 1000 messages once across repeated transcript renders and invalidates changed content', async () => {
    const parse = vi.spyOn(marked, 'parse');
    const fixture = await setup();
    const root = fixture.nativeElement as HTMLElement;
    for (let page = 0; page < 6; page++) {
      root.querySelector<HTMLButtonElement>('[aria-label="Show earlier messages"]')!.click();
      fixture.detectChanges();
      await fixture.whenStable();
    }
    expect(root.querySelectorAll('.message')).toHaveLength(1000);
    fixture.componentRef.setInput('messages', messages.map(message => ({ ...message })));
    await fixture.whenStable();
    expect(parse).toHaveBeenCalledTimes(1000);
    fixture.componentRef.setInput('messages', messages.map((message, index) => index === 999 ? { ...message, content: 'Changed **tail**' } : message));
    await fixture.whenStable();
    expect(parse).toHaveBeenCalledTimes(1001);
    expect(root.querySelector('.message:last-child strong')?.textContent).toBe('tail');
    parse.mockRestore();
  }, 180_000);
});
