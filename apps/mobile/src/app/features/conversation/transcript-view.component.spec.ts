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

describe('Windowed memoised transcript', () => {
  it.each(['stamp', 'tool-group'])('falls back to a surviving message when the %s anchor merges at a page boundary', async (kind) => {
    const transcript = messages.slice(0, 299).map((message, i) => ({ ...message, timestamp: 1_750_000_000_000 + i * 1000,
      type: kind === 'tool-group' && (i === 149 || i === 150) ? 'tool_use' as const : 'assistant' as const }));
    const fixture = await setup(transcript.slice(150));
    fixture.componentRef.setInput('hasEarlier', true);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const scroll = root.querySelector<HTMLElement>('.transcript')!;
    const primary = root.querySelector<HTMLElement>(`.${kind}`)!;
    const survivor = root.querySelector<HTMLElement>('.message')!;
    let inserted = false;
    vi.spyOn(primary, 'getBoundingClientRect').mockImplementation(() => ({ top: 100, bottom: 120 }) as DOMRect);
    vi.spyOn(survivor, 'getBoundingClientRect').mockImplementation(() => ({ top: 150 + (inserted ? 5000 : 0) - scroll.scrollTop, bottom: 200 }) as DOMRect);
    vi.spyOn(scroll, 'scrollHeight', 'get').mockReturnValue(20_000);
    const frames: FrameRequestCallback[] = [];
    const animation = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
    try {
      scroll.scrollTop = 0;
      root.querySelector<HTMLButtonElement>('[aria-label="Show earlier messages"]')!.click();
      fixture.componentRef.setInput('earlierLoading', true);
      await fixture.whenStable();
      inserted = true;
      fixture.componentRef.setInput('messages', transcript);
      fixture.componentRef.setInput('earlierLoading', false);
      await fixture.whenStable();
      for (let frame = 0; frame < 10 && frames.length; frame++) frames.shift()!(0);
      expect(primary.isConnected).toBe(false);
      expect(survivor.isConnected).toBe(true);
      expect(scroll.scrollTop).toBe(5000);
      expect(survivor.getBoundingClientRect().top).toBe(150);
    } finally { animation.mockRestore(); }
  });

  it('uses scroll extent fallback and releases the anchor when every old display item was rekeyed', async () => {
    const tool = { ...messages[1], type: 'tool_use' as const, timestamp: 1_750_000_001_000 };
    const fixture = await setup([tool]);
    fixture.componentRef.setInput('hasEarlier', true);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const scroll = root.querySelector<HTMLElement>('.transcript')!;
    let height = 100;
    vi.spyOn(scroll, 'scrollHeight', 'get').mockImplementation(() => height);
    vi.spyOn(scroll, 'clientHeight', 'get').mockReturnValue(100);
    vi.spyOn(root.querySelector('.stamp')!, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 30 } as DOMRect);
    scroll.scrollTop = 0;
    root.querySelector<HTMLButtonElement>('[aria-label="Show earlier messages"]')!.click();
    fixture.componentRef.setInput('earlierLoading', true);
    await fixture.whenStable();
    height = 300;
    const merged = [{ ...tool, id: 'earlier-tool', timestamp: tool.timestamp - 1000 }, tool];
    fixture.componentRef.setInput('messages', merged);
    fixture.componentRef.setInput('earlierLoading', false);
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(200);
    height = 600;
    fixture.componentRef.setInput('messages', [...merged, { ...messages[2], timestamp: tool.timestamp + 1000 }]);
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(600);
  });
  it('resets a pending earlier-message anchor when the transcript identity changes', async () => {
    const fixture = await setup();
    const scroll = fixture.nativeElement.querySelector('.transcript') as HTMLElement;
    vi.spyOn(scroll, 'scrollHeight', 'get').mockReturnValue(10_000);
    fixture.nativeElement.querySelector('[aria-label="Show earlier messages"]').click();
    fixture.componentRef.setInput('transcriptKey', 'other-host:other-session');
    fixture.componentRef.setInput('messages', messages.slice(-150).map(item => ({ ...item, id: `other-${item.id}` })));
    await fixture.whenStable();
    expect(scroll.scrollTop).toBe(10_000);
    expect(fixture.nativeElement.querySelectorAll('.message')).toHaveLength(150);
  });
  // Multi-page JSDOM fixtures can exceed 5s under load; keep the real DOM assertions.
  it('keeps the same reveal size when retrying an earlier-page failure', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput('messages', messages.slice(700));
    fixture.componentRef.setInput('hasEarlier', true);
    await fixture.whenStable();
    const earlier = () => fixture.nativeElement.querySelector('[aria-label="Show earlier messages"]') as HTMLButtonElement;
    earlier().click(); await fixture.whenStable();
    earlier().click(); await fixture.whenStable();
    fixture.componentRef.setInput('earlierError', 'Try again'); await fixture.whenStable();
    earlier().click();
    fixture.componentRef.setInput('earlierError', null);
    fixture.componentRef.setInput('messages', messages.slice(500));
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.message')).toHaveLength(450);
  }, 60_000);

  // This also renders a full 300-item page in JSDOM, including while offline.
  it('reveals already cached earlier messages while offline', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput('earlierDisabled', true);
    await fixture.whenStable();
    const earlier = fixture.nativeElement.querySelector('[aria-label="Show earlier messages"]') as HTMLButtonElement;
    expect(earlier.disabled).toBe(false);
    earlier.click(); await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.message')).toHaveLength(300);
  }, 60_000);

  // Use the same scoped allowance as the other DOM-heavy transcript fixtures.
  it('starts with the last 150 display items and reveals 150 earlier items per click', async () => {
    const fixture = await setup();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('.message')).toHaveLength(150);
    expect(root.querySelector('.message')?.textContent).toContain('850');
    root.querySelector<HTMLButtonElement>('[aria-label="Show earlier messages"]')!.click();
    await fixture.whenStable();
    expect(root.querySelectorAll('.message')).toHaveLength(300);
    expect(root.querySelector('.message')?.textContent).toContain('700');
  }, 60_000);

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
  }, 60_000);

  it('releases memoised messages when the transcript is dropped', async () => {
    const fixture = await setup();
    fixture.componentRef.setInput('messages', []);
    await fixture.whenStable();
    const parse = vi.spyOn(marked, 'parse');
    fixture.componentRef.setInput('messages', messages);
    await fixture.whenStable();
    expect(parse).toHaveBeenCalledTimes(150);
    parse.mockRestore();
  }, 60_000);
});
