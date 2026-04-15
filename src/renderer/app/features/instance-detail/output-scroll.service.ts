import { inject, Injectable, WritableSignal } from '@angular/core';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';
import { OutputMessage } from '../../core/state/instance.store';

export interface ScrollState {
  showScrollToTop: WritableSignal<boolean>;
  showScrollToBottom: WritableSignal<boolean>;
  scrollPositions: Map<string, number>;
  userScrolledUp: { value: boolean };
}

export interface ScrollListenerBinding {
  element: HTMLElement;
  listener: EventListener;
}

@Injectable({ providedIn: 'root' })
export class OutputScrollService {
  private perf = inject(PerfInstrumentationService);

  /**
   * Setup scroll event listener to detect user scrolling and trigger load-more.
   * Returns the element and bound listener so the caller can remove it on destroy.
   */
  setupScrollListener(
    el: HTMLElement,
    state: ScrollState,
    instanceIdFn: () => string,
    messagesFn: () => OutputMessage[],
    isLoadingOlderFn: () => boolean,
    hasOlderMessagesFn: () => boolean,
    loadOlderMessagesFn: () => void,
  ): ScrollListenerBinding {
    let lastScrollTime = 0;

    const listener: EventListener = () => {
      // Measure scroll frame timing for perf budget
      const now = performance.now();
      if (lastScrollTime > 0) {
        this.perf.recordScrollFrame(instanceIdFn(), now - lastScrollTime, messagesFn().length);
      }
      lastScrollTime = now;

      const scrollOffset = el.scrollTop;
      const viewportSize = el.clientHeight;
      const totalSize = el.scrollHeight;
      const autoScrollThreshold = 100;
      const buttonShowThreshold = 50;

      const distanceFromBottom = totalSize - scrollOffset - viewportSize;
      const distanceFromTop = scrollOffset;

      state.userScrolledUp.value = distanceFromBottom > autoScrollThreshold;
      state.showScrollToTop.set(distanceFromTop > buttonShowThreshold);
      state.showScrollToBottom.set(distanceFromBottom > buttonShowThreshold);
      state.scrollPositions.set(instanceIdFn(), scrollOffset);

      // Trigger loading older messages when near the top
      if (distanceFromTop < 200 && !isLoadingOlderFn() && hasOlderMessagesFn()) {
        loadOlderMessagesFn();
      }
    };

    el.addEventListener('scroll', listener, { passive: true });
    return { element: el, listener };
  }

  /**
   * Scroll to the top of the container.
   */
  scrollToTop(el: HTMLElement, state: Pick<ScrollState, 'showScrollToTop'>): void {
    el.scrollTo({ top: 0, behavior: 'smooth' });
    state.showScrollToTop.set(false);
  }

  /**
   * Scroll to the bottom of the container.
   */
  scrollToBottom(
    el: HTMLElement,
    state: Pick<ScrollState, 'showScrollToBottom' | 'userScrolledUp'>,
  ): void {
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    state.userScrolledUp.value = false;
    state.showScrollToBottom.set(false);
  }
}
