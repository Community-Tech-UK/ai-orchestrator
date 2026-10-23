import { Component } from '@angular/core';
import { CdkScrollable } from '@angular/cdk/scrolling';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AioTooltipDirective } from './aio-tooltip.directive';
import { TitleTooltipBridge } from './title-tooltip-bridge';
import { getLastTooltipClosedAt, tooltipHostElements } from './tooltip-registry';

@Component({ standalone: true, imports: [CdkScrollable], template: '<div cdkScrollable id="transcript">Streaming reply</div>' })
class Transcript {}
@Component({ standalone: true, imports: [AioTooltipDirective], template: '<div title="Outer"><button appTooltip="Inner" aria-label="Inner">×</button></div>' })
class ExplicitHost {}

const warnings = [
  'Not yet saved for crash recovery — a renderer crash right now could lose this message',
  'Discard changes (revert to HEAD)', 'Delete all conversation history', 'YOLO mode ON — auto-approve all actions',
  'Enable YOLO mode to auto-approve all permissions for this session',
  "Close this computer's live connection without revoking it. It reconnects by itself.",
  'Archive this sidechat (keeps history, removes it from the list)', 'Steer this queued message now',
  'Unstage file (git restore --staged)', 'Move to Trash (recoverable)', 'Edit queued message', 'Attachments could not be restored for this queued message',
];
function tooltip(): HTMLElement | null { return document.querySelector('[role="tooltip"]'); }
function pointer(el: Element, type = 'pointerover', relatedTarget: Element | null = null, pointerType = 'mouse'): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, relatedTarget, pointerType }));
}
function focus(el: HTMLElement): void {
  const matches = el.matches.bind(el); vi.spyOn(el, 'matches').mockImplementation(s => s === ':focus-visible' || matches(s));
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}
async function paint(): Promise<void> { await Promise.resolve(); TestBed.tick(); }

describe('native title bridge', () => {
  let bridge: TitleTooltipBridge; let root: HTMLElement;
  function element(title: string, tag = 'button', label = ''): HTMLElement {
    const el = document.createElement(tag); el.title = title; el.textContent = label; root.append(el); return el;
  }
  async function hover(el: Element): Promise<void> { pointer(el); vi.advanceTimersByTime(600); await paint(); }
  beforeEach(() => {
    vi.useFakeTimers(); TestBed.configureTestingModule({ imports: [Transcript, ExplicitHost] }); bridge = TestBed.inject(TitleTooltipBridge);
    root = document.createElement('div'); document.body.append(root); bridge.start(); vi.setSystemTime(Math.max(Date.now(), getLastTooltipClosedAt()) + 301);
  });
  afterEach(() => { bridge.stop(); root.remove(); TestBed.resetTestingModule(); vi.useRealTimers(); expect(tooltip()).toBeNull(); });
  it.each(warnings)('shows title wording verbatim: %s', async text => {
    const el = element(text); await hover(el); expect(tooltip()?.textContent).toBe(text);
    expect(el.title).toBe(''); pointer(el, 'pointerout'); expect(el.title).toBe(text);
  });
  it('uses policy delays for controls, plain labels, truncation and shared skip windows', async () => {
    const button = element('History'); pointer(button); vi.advanceTimersByTime(199); expect(tooltip()).toBeNull();
    vi.advanceTimersByTime(1); await paint(); expect(tooltip()).not.toBeNull(); pointer(button, 'pointerout');
    const next = element('Settings'); pointer(next); await paint(); expect(tooltip()?.textContent).toBe('Settings'); pointer(next, 'pointerout');
    vi.advanceTimersByTime(301); const label = element('Long label', 'span'); pointer(label); vi.advanceTimersByTime(599); expect(tooltip()).toBeNull();
    vi.advanceTimersByTime(1); await paint(); expect(tooltip()).not.toBeNull(); pointer(label, 'pointerout');
    vi.advanceTimersByTime(301); Object.defineProperty(button, 'scrollWidth', { value: 100 }); Object.defineProperty(button, 'clientWidth', { value: 30 });
    pointer(button); vi.advanceTimersByTime(599); expect(tooltip()).toBeNull(); vi.advanceTimersByTime(1); await paint(); expect(tooltip()).not.toBeNull();
  });
  it('only suppresses exact visible matches and preserves additional warning words', async () => {
    const el = element('not saved: a crash could lose this message', 'span', 'not saved'); await hover(el);
    expect(tooltip()?.textContent).toBe(el.getAttribute('aria-label') ?? 'not saved: a crash could lose this message');
    pointer(el, 'pointerout'); const redundant = element('Pause', 'button', ' pause '); await hover(redundant);
    expect(tooltip()).toBeNull(); expect(redundant.title).toBe('');
  });
  it('does not suppress labels hidden with display none', async () => {
    const el = element('History'); el.innerHTML = '<span style="display:none">History</span>'; await hover(el);
    expect(tooltip()?.textContent).toBe('History');
  });
  it('a click or Escape hides without restoring native title until exit', async () => {
    const el = element('Close'); await hover(el); pointer(el, 'pointerdown'); expect(tooltip()).toBeNull(); expect(el.title).toBe('');
    pointer(el, 'pointerout'); expect(el.title).toBe('Close'); await hover(el);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); expect(el.title).toBe(''); expect(tooltip()).toBeNull();
  });
  it('keeps an Escape dismissal across child moves until the pointer really leaves', async () => {
    const el = element('Delete all conversation history'); el.innerHTML = '<span>Delete</span><span>history</span>';
    const spans = el.querySelectorAll('span'); const first = spans[0]!; const second = spans[1]!;
    await hover(el); expect(tooltip()?.textContent).toBe('Delete all conversation history');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); expect(tooltip()).toBeNull();
    pointer(first, 'pointerout', second); pointer(second, 'pointerover', first); vi.advanceTimersByTime(650); await paint();
    expect(tooltip()).toBeNull(); expect(el.title).toBe('');
    pointer(second, 'pointerout', root); expect(el.title).toBe('Delete all conversation history');
    await hover(el); expect(tooltip()?.textContent).toBe('Delete all conversation history');
  });
  it('keeps a click dismissal past its block window across child moves', async () => {
    const el = element('Delete all conversation history'); el.innerHTML = '<span>Delete</span><span>history</span>';
    const spans = el.querySelectorAll('span'); const first = spans[0]!; const second = spans[1]!;
    await hover(el); pointer(first, 'pointerdown'); expect(tooltip()).toBeNull();
    vi.advanceTimersByTime(400);
    pointer(first, 'pointerout', second); pointer(second, 'pointerover', first); vi.advanceTimersByTime(650); await paint();
    expect(tooltip()).toBeNull(); expect(el.title).toBe('');
  });
  it('keeps a scroll dismissal across child moves until the pointer really leaves', async () => {
    const el = element('Delete all conversation history'); el.innerHTML = '<span>Delete</span><span>history</span>';
    const spans = el.querySelectorAll('span'); const first = spans[0]!; const second = spans[1]!;
    await hover(el); root.dispatchEvent(new Event('scroll')); expect(tooltip()).toBeNull();
    pointer(first, 'pointerout', second); pointer(second, 'pointerover', first); vi.advanceTimersByTime(650); await paint();
    expect(tooltip()).toBeNull(); expect(el.title).toBe('');
    pointer(second, 'pointerout', root); await hover(el); expect(tooltip()?.textContent).toBe('Delete all conversation history');
  });
  it('a click blocks only its own control, never a different hint entered next', async () => {
    const clicked = element('Settings'); const warned = element('Delete all conversation history');
    await hover(clicked); pointer(clicked, 'pointerdown'); expect(tooltip()).toBeNull();
    pointer(warned); vi.advanceTimersByTime(650); await paint();
    expect(tooltip()?.textContent).toBe('Delete all conversation history'); expect(warned.title).toBe('');
    pointer(warned, 'pointerout', root); expect(warned.title).toBe('Delete all conversation history');
  });
  it('defers to explicit hosts while blanking their titled ancestor', async () => {
    const parent = element('Outer', 'div'); const host = document.createElement('button'); parent.append(host); tooltipHostElements.add(host);
    await hover(host); expect(tooltip()).toBeNull(); expect(parent.title).toBe('');
    host.innerHTML = '<svg><path /></svg>'; await hover(host.querySelector('path')!);
    expect(tooltip()).toBeNull(); expect(parent.title).toBe('');
    pointer(host, 'pointerout', root); expect(parent.title).toBe('Outer'); tooltipHostElements.delete(host);
  });
  it('the real directive preempts a bridge panel and keeps the ancestor native bubble suppressed', async () => {
    const native = element('Native'); await hover(native); expect(tooltip()?.textContent).toBe('Native');
    const fixture = TestBed.createComponent(ExplicitHost); fixture.detectChanges();
    const button: HTMLElement = fixture.nativeElement.querySelector('button');
    pointer(button); button.dispatchEvent(new MouseEvent('mouseenter')); vi.advanceTimersByTime(200); fixture.detectChanges();
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1); expect(tooltip()?.textContent).toBe('Inner');
    expect(button.parentElement?.getAttribute('title')).toBe(''); expect(native.title).toBe('Native');
    button.click(); fixture.detectChanges(); expect(tooltip()).toBeNull(); expect(button.parentElement?.getAttribute('title')).toBe('');
    pointer(button, 'pointerout'); expect(button.parentElement?.getAttribute('title')).toBe('Outer'); fixture.destroy();
  });
  it('keeps a single blanked slot and blocks outer inheritance through the empty child title', async () => {
    const parent = element('Outer', 'div'); const child = element('Inner'); parent.append(child); await hover(parent);
    await hover(child); expect(parent.title).toBe('Outer'); expect(child.title).toBe(''); expect(tooltip()?.textContent).toBe('Inner');
    pointer(child, 'pointerout', parent); pointer(parent); vi.advanceTimersByTime(600); await paint(); expect(child.title).toBe('Inner'); expect(parent.title).toBe('');
    pointer(parent, 'pointerout'); expect(parent.title).toBe('Outer');
  });
  it('an empty native title cancels an ancestor', async () => {
    const parent = element('Outer', 'div'); const child = element(''); parent.append(child); await hover(child);
    expect(tooltip()).toBeNull(); expect(parent.title).toBe('Outer');
  });
  it('opens the HTML host hint verbatim when entering its inline SVG path', async () => {
    const text = 'Discard changes (revert to HEAD)'; const host = element(text);
    host.innerHTML = '<svg title="Icon"><title>Shape</title><path title="Path" /></svg>';
    const path = host.querySelector('path')!; await hover(path);
    expect(tooltip()?.textContent).toBe(text); expect(host.title).toBe('');
    expect(path.getAttribute('title')).toBe('Path'); expect(host.querySelector('svg')?.getAttribute('title')).toBe('Icon');
    pointer(path, 'pointerout', root); expect(tooltip()).toBeNull(); expect(host.title).toBe(text);
  });
  it('keeps the same hint and blank title when moving from HTML padding into its SVG path', async () => {
    const host = element('Delete all conversation history'); host.innerHTML = '<svg><path /></svg>';
    const path = host.querySelector('path')!; await hover(host); const panel = tooltip(); expect(panel).not.toBeNull();
    pointer(host, 'pointerout', path); pointer(path, 'pointerover', host); await paint();
    expect(tooltip()).toBe(panel); expect(tooltip()?.textContent).toBe('Delete all conversation history'); expect(host.title).toBe('');
    pointer(path, 'pointerout', root); expect(tooltip()).toBeNull(); expect(host.title).toBe('Delete all conversation history');
  });
  it('ignores standalone SVG titles without an eligible HTML title source', async () => {
    root.innerHTML = '<svg title="Icon"><title>Shape</title><path title="Path" /></svg>';
    const svg = root.querySelector('svg')!; const path = root.querySelector('path')!;
    await hover(path); expect(tooltip()).toBeNull(); expect(path.getAttribute('title')).toBe('Path');
    await hover(svg); expect(tooltip()).toBeNull(); expect(svg.getAttribute('title')).toBe('Icon');
  });
  it('ignores component hosts, embedded documents, opt-outs and touch without upgrading an ancestor', async () => {
    for (const tag of ['app-card', 'iframe', 'object', 'embed']) {
      const parent = element('Outer', 'div'); const el = element('Heading', tag); parent.append(el); await hover(el);
      expect(tooltip()).toBeNull(); expect(el.title).toBe('Heading'); expect(parent.title).toBe('Outer');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); svg.append(path); el.append(svg); await hover(path);
      expect(tooltip()).toBeNull(); expect(el.title).toBe('Heading'); expect(parent.title).toBe('Outer');
    }
    const off = element('Off'); off.setAttribute('data-title-tooltip', 'off'); await hover(off); expect(off.title).toBe('Off');
    off.innerHTML = '<svg><path /></svg>'; await hover(off.querySelector('path')!); expect(tooltip()).toBeNull(); expect(off.title).toBe('Off');
    const optedOutIcon = element('Host'); optedOutIcon.innerHTML = '<svg data-title-tooltip="off"><path /></svg>';
    await hover(optedOutIcon.querySelector('path')!); expect(tooltip()).toBeNull(); expect(optedOutIcon.title).toBe('Host');
    const touch = element('Touch'); pointer(touch, 'pointerover', null, 'touch'); vi.advanceTimersByTime(600); await paint(); expect(touch.title).toBe('Touch');
  });
  it('updates rebound wording and lent names, then does not resurrect a removed title', async () => {
    const el = element('Old'); await hover(el); el.title = 'New'; await paint();
    expect(tooltip()?.textContent).toBe('New'); expect(el.title).toBe(''); expect(el.getAttribute('aria-label')).toBe('New');
    el.removeAttribute('title'); await paint(); expect(tooltip()).toBeNull(); bridge.stop(); expect(el.hasAttribute('title')).toBe(false); expect(el.hasAttribute('aria-label')).toBe(false);
  });
  it('honors title removal before the mutation microtask on stop', async () => {
    const el = element('Old'); await hover(el); el.removeAttribute('title'); bridge.stop();
    expect(el.hasAttribute('title')).toBe(false); expect(el.hasAttribute('aria-label')).toBe(false); expect(tooltip()).toBeNull();
  });
  it('an externally bound empty title clears the hint without restoring stale wording', async () => {
    const el = element('Old'); await hover(el); el.title = ''; await paint(); bridge.stop(); expect(el.title).toBe(''); expect(tooltip()).toBeNull();
  });
  it('updates keyboard hints when Angular changes or removes their title', async () => {
    const el = element('Old'); focus(el); await paint(); el.title = 'New'; await paint();
    expect(tooltip()?.textContent).toBe('New'); expect(el.title).toBe('New');
    el.removeAttribute('title'); await paint(); expect(tooltip()).toBeNull();
  });
  it('flushes pending rebinds before stop and respects externally changed accessible names', async () => {
    const el = element('Old'); await hover(el); el.title = 'New'; el.setAttribute('aria-label', 'Owner name'); bridge.stop();
    expect(el.title).toBe('New'); expect(el.getAttribute('aria-label')).toBe('Owner name');
  });
  it('hides only scrolls that move its anchor', async () => {
    const el = element('Close'); await hover(el); const unrelated = element('', 'div'); unrelated.dispatchEvent(new Event('scroll'));
    expect(tooltip()).not.toBeNull(); root.dispatchEvent(new Event('scroll')); expect(tooltip()).toBeNull(); expect(el.title).toBe('');
  });
  it('ignores unrelated registered CDK scrolling while a reply streams', async () => {
    const fixture = TestBed.createComponent(Transcript); fixture.detectChanges();
    const el = element('History'); await hover(el);
    fixture.nativeElement.querySelector('#transcript').dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(20); await paint(); expect(tooltip()).not.toBeNull(); fixture.destroy();
  });
  it('lends names only to unnamed hosts and restores descriptions without losing owner updates', async () => {
    const el = element('Close'); el.setAttribute('aria-describedby', 'hint'); await hover(el);
    expect(el.getAttribute('aria-label')).toBe('Close'); expect(el.getAttribute('aria-describedby')).toBe('hint');
    pointer(el, 'pointerout'); expect(el.hasAttribute('aria-label')).toBe(false);
    el.setAttribute('aria-labelledby', 'name'); await hover(el); expect(el.hasAttribute('aria-label')).toBe(false);
  });
  it('shows keyboard hints immediately without blanking title, and retains suppression on pointer focus transitions', async () => {
    const el = element('Close'); focus(el); await paint(); expect(tooltip()?.textContent).toBe('Close'); expect(el.title).toBe('Close');
    pointer(el); expect(el.title).toBe(''); pointer(el, 'pointerout'); expect(el.title).toBe('Close');
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); expect(tooltip()).toBeNull();
  });
  it('formats transcript code anchors and cleans up on global exits and detached hosts', async () => {
    const el = element('/folder/file.ts', 'code'); await hover(el); expect(tooltip()?.classList.contains('aio-tooltip--code')).toBe(true);
    for (const event of ['blur', 'pagehide']) { window.dispatchEvent(new Event(event)); expect(el.title).toBe('/folder/file.ts'); await hover(el); }
    document.dispatchEvent(new Event('visibilitychange')); expect(el.title).toBe('/folder/file.ts'); await hover(el); el.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' })); expect(el.title).toBe('/folder/file.ts'); expect(tooltip()).toBeNull();
  });
  it('preserves title and name invariants over seeded event sequences', async () => {
    const elements = [element('A'), element('B', 'span'), element('C')]; let seed = 412;
    const bound = new Map(elements.map(el => [el, el.title]));
    for (let i = 0; i < 100; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0; const el = elements[seed % elements.length];
      switch ((seed >>> 4) % 14) {
        case 0: pointer(el); break;
        case 1: pointer(el, 'pointerout'); break;
        case 2: pointer(el, 'pointerdown'); break;
        case 3: window.dispatchEvent(new Event('blur')); break;
        case 4: el.title = 'Bound ' + i; bound.set(el, el.title); break;
        case 5: el.removeAttribute('title'); bound.delete(el); break;
        case 6: focus(el); break;
        case 7: el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); break;
        case 8: document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); break;
        case 9: root.dispatchEvent(new Event('scroll')); break;
        case 10: document.dispatchEvent(new Event('visibilitychange')); break;
        case 11: window.dispatchEvent(new Event('pagehide')); break;
        case 12: el.remove(); document.dispatchEvent(new Event('scroll')); root.append(el); break;
        case 13: pointer(el, 'pointerover', null, 'touch'); break;
      }
      await paint(); expect(elements.filter(item => item.getAttribute('title') === '')).toHaveLength(elements.some(item => item.getAttribute('title') === '') ? 1 : 0);
    }
    bridge.stop();
    for (const el of elements) { expect(el.getAttribute('title')).toBe(bound.get(el) ?? null); expect(el.hasAttribute('aria-label')).toBe(false); }
  });
});
