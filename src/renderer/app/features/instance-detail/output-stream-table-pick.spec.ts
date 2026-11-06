import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { MarkdownService } from '../../core/services/markdown.service';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { OutputStreamComponent } from './output-stream.component';
import type { OutputMessage } from '../../core/state/instance/instance.types';

describe('OutputStreamComponent table picks', () => {
  it('keeps picks disabled without a working composer destination', () => {
    const message = { type: 'assistant', metadata: {} } as OutputMessage;
    const hostState = {
      sessionStatus: () => 'idle' as const,
      instanceStore: { getInstance: () => undefined },
      instanceId: () => 'inst-1',
    };
    const withDestination = Object.assign(Object.create(OutputStreamComponent.prototype), hostState, {
      tablePicksToComposer: () => true,
    }) as { areTablePicksDisabled(message: OutputMessage): boolean };
    const withoutDestination = Object.assign(Object.create(OutputStreamComponent.prototype), hostState, {
      tablePicksToComposer: () => false,
    }) as { areTablePicksDisabled(message: OutputMessage): boolean };
    expect(withDestination.areTablePicksDisabled(message)).toBe(false);
    expect(withoutDestination.areTablePicksDisabled(message)).toBe(true);
  });

  it.each([
    ['app-thought-process', ''],
    ['app-system-event-group', ''],
    ['app-thought-process', 'md-row-picking-enabled'],
    ['app-system-event-group', 'md-row-picking-enabled'],
  ])('keeps %s tables inactive inside an enabled reply (inner marker: %s)', (host, marker) => {
    TestBed.configureTestingModule({ providers: [{ provide: CLIPBOARD_SERVICE, useValue: {} }] });
    const markdown = TestBed.inject(MarkdownService);
    const container = document.createElement('div');
    container.className = 'markdown-content md-row-picking-enabled';
    container.innerHTML = `<${host}><div class="markdown-content ${marker}">${markdown.renderSync('| # | Finding |\n| --- | --- |\n| 1 | Internal detail |')}</div></${host}>`;
    const appended: string[] = [];
    const component = Object.assign(Object.create(OutputStreamComponent.prototype), {
      getViewportElement: () => container,
      appendToComposer: { emit: (text: string) => appended.push(text) },
    }) as { setupDelegatedClickHandler(): { element: HTMLElement; listener: EventListener } };
    const binding = component.setupDelegatedClickHandler();
    try {
      container.querySelector<HTMLElement>('[data-pick-row] span')!.click();
      container.querySelector<HTMLButtonElement>('[data-pick-add]')!.click();
      expect(appended).toEqual([]);
      expect(container.querySelector('[data-pick-row]')?.getAttribute('aria-pressed')).toBe('false');
      container.querySelector('[data-pick-row]')!.setAttribute('aria-pressed', 'true');
      container.querySelector<HTMLButtonElement>('[data-pick-add]')!.click();
      expect(appended).toEqual([]);
    } finally {
      binding.element.removeEventListener('click', binding.listener);
    }
  });

  it('delegates nested pick and add clicks to one composer append event', () => {
    const container = document.createElement('div');
    container.className = 'markdown-content md-row-picking-enabled';
    container.innerHTML = '<div class="table-wrapper"><table><tr><td><button type="button" data-pick-row="3" data-pick-text="&quot;Finding: Fix export&quot;" aria-pressed="false"><span>Pick</span></button></td></tr></table><div data-pick-bar data-pick-count="0"><span data-pick-count-label></span><button type="button" data-pick-add>Add to reply</button></div></div>';
    const appended: string[] = [];
    const component = Object.assign(Object.create(OutputStreamComponent.prototype), {
      getViewportElement: () => container,
      appendToComposer: { emit: (text: string) => appended.push(text) },
    }) as { setupDelegatedClickHandler(): { element: HTMLElement; listener: EventListener } };
    const binding = component.setupDelegatedClickHandler();
    try {
      container.querySelector<HTMLElement>('[data-pick-row] span')!.click();
      expect(container.querySelector('[data-pick-row]')?.getAttribute('aria-pressed')).toBe('true');
      container.querySelector<HTMLButtonElement>('[data-pick-add]')!.click();
      expect(appended).toEqual(['Row 3 from your table:\n- 3: Finding: Fix export']);
      container.querySelector<HTMLButtonElement>('[data-pick-add]')!.click();
      expect(appended).toHaveLength(1);
    } finally {
      binding.element.removeEventListener('click', binding.listener);
    }
  });
});
