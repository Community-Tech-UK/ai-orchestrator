import { describe, expect, it, vi } from 'vitest';
import { OutputStreamComponent } from './output-stream.component';

describe('OutputStreamComponent delegated follow-up clicks', () => {
  it('routes clicks on a nested button label to the prompt clipboard action', () => {
    const container = document.createElement('div');
    container.innerHTML = '<button type="button" data-followup-prompt="&quot;Write a draft&quot;"><span>Draft reply</span></button>';
    const handleFollowupClick = vi.fn().mockResolvedValue(undefined);
    // Exercise the actual listener without starting unrelated transcript effects.
    const component = Object.assign(Object.create(OutputStreamComponent.prototype), {
      getViewportElement: () => container,
      markdownService: { handleFollowupClick },
    }) as { setupDelegatedClickHandler(): { element: HTMLElement; listener: EventListener } };
    const binding = component.setupDelegatedClickHandler();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    container.querySelector('span')!.dispatchEvent(event);

    expect(handleFollowupClick).toHaveBeenCalledExactlyOnceWith(container.querySelector('button'));
    expect(event.defaultPrevented).toBe(true);
    binding.element.removeEventListener('click', binding.listener);
    container.querySelector('span')!.click();
    expect(handleFollowupClick).toHaveBeenCalledTimes(1);
  });
});
