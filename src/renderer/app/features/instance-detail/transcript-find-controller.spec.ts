import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TranscriptFindController } from './transcript-find-controller';

async function waitForController(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      window.setTimeout(() => {
        requestAnimationFrame(() => resolve());
      }, 20);
    });
    if (predicate()) {
      return;
    }
  }
  throw new Error('Timed out waiting for transcript find controller');
}

describe('TranscriptFindController', () => {
  let root: HTMLElement;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
    scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    root.remove();
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    vi.restoreAllMocks();
  });

  it('searches the rendered transcript DOM and activates the first match', async () => {
    root.innerHTML = '<article>Agent output contains send queue pressure.</article>';
    const controller = new TranscriptFindController({
      getViewportElement: () => root,
      hasOlderMessages: () => false,
      loadOlderMessages: async () => undefined,
    });

    controller.openFind();
    controller.setQuery('send queue');
    await waitForController(() => controller.matchCount() === 1);

    expect(controller.matchCount()).toBe(1);
    expect(controller.activeIndex()).toBe(0);
    expect(root.querySelector('mark.transcript-find-match.active')?.textContent).toBe('send queue');
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it('loads older chunks when moving before the first loaded match', async () => {
    root.innerHTML = '<article>Current window sendq match.</article>';
    let hasOlderMessages = true;
    const controller = new TranscriptFindController({
      getViewportElement: () => root,
      hasOlderMessages: () => hasOlderMessages,
      loadOlderMessages: async () => {
        root.insertAdjacentHTML('afterbegin', '<article>Older sendq match.</article>');
        hasOlderMessages = false;
      },
    });

    controller.openFind();
    controller.setQuery('sendq');
    await waitForController(() => controller.matchCount() === 1);

    await controller.previousMatch();

    const matches = Array.from(root.querySelectorAll('mark.transcript-find-match'));
    expect(matches.map((match) => match.textContent)).toEqual(['sendq', 'sendq']);
    expect(controller.matchCount()).toBe(2);
    expect(controller.activeIndex()).toBe(0);
    expect(root.querySelector('mark.transcript-find-match.active')?.parentElement?.textContent)
      .toBe('Older sendq match.');
  });

  it('loads older chunks when the visible transcript has no matches', async () => {
    root.innerHTML = '<article>Current window has unrelated text.</article>';
    let hasOlderMessages = true;
    const controller = new TranscriptFindController({
      getViewportElement: () => root,
      hasOlderMessages: () => hasOlderMessages,
      loadOlderMessages: async () => {
        root.insertAdjacentHTML('afterbegin', '<article>Older chunk contains sendq.</article>');
        hasOlderMessages = false;
      },
    });

    controller.openFind();
    controller.setQuery('sendq');
    await waitForController(() => controller.matchCount() === 1);

    expect(controller.matchCount()).toBe(1);
    expect(controller.activeIndex()).toBe(0);
    expect(root.querySelector('mark.transcript-find-match.active')?.parentElement?.textContent)
      .toBe('Older chunk contains sendq.');
  });

  it('loads older chunks before wrapping past the last loaded match', async () => {
    root.innerHTML = '<article>Current first sendq.</article><article>Current second sendq.</article>';
    let hasOlderMessages = true;
    const controller = new TranscriptFindController({
      getViewportElement: () => root,
      hasOlderMessages: () => hasOlderMessages,
      loadOlderMessages: async () => {
        root.insertAdjacentHTML('afterbegin', '<article>Oldest sendq.</article>');
        hasOlderMessages = false;
      },
    });

    controller.openFind();
    controller.setQuery('sendq');
    await waitForController(() => controller.matchCount() === 2);

    await controller.nextMatch();
    await controller.nextMatch();

    const matches = Array.from(root.querySelectorAll('mark.transcript-find-match'));
    expect(matches.map((match) => match.textContent)).toEqual(['sendq', 'sendq', 'sendq']);
    expect(controller.matchCount()).toBe(3);
    expect(controller.activeIndex()).toBe(0);
    expect(root.querySelector('mark.transcript-find-match.active')?.parentElement?.textContent)
      .toBe('Oldest sendq.');
  });
});
