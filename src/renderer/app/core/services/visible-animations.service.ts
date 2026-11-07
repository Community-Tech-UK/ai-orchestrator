import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';

type VisibilityObserver = Pick<IntersectionObserver, 'observe' | 'unobserve' | 'disconnect'>;

/** Own only pauses introduced here; finite transitions and deliberate pauses keep their behaviour. */
export function watchVisibleAnimations(document: Document,
  createObserver: (callback: IntersectionObserverCallback) => VisibilityObserver = callback => new IntersectionObserver(callback),
  schedule: (run: () => void) => () => void = run => { const id = requestAnimationFrame(run); return () => cancelAnimationFrame(id); },
): () => void {
  const targets = new Map<Element, Set<Animation>>();
  const visible = new Set<Element>();
  const paused = new Set<Animation>();
  const update = (target: Element) => {
    for (const animation of targets.get(target) ?? []) {
      if (document.hidden || !visible.has(target)) {
        if (animation.playState === 'running' && !paused.has(animation)) { animation.pause(); paused.add(animation); }
      } else if (paused.delete(animation) && animation.playState !== 'finished' && animation.playState !== 'idle') animation.play();
    }
  };
  const observer = createObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target);
      update(entry.target);
    }
  });
  const discover = () => {
    const current = new Set(document.getAnimations());
    for (const [target, group] of targets) {
      for (const animation of group) if (!current.has(animation)) { group.delete(animation); paused.delete(animation); }
      if (!group.size) { observer.unobserve(target); targets.delete(target); visible.delete(target); }
    }
    for (const animation of current) {
      const effect = animation.effect as KeyframeEffect | null;
      const target = effect?.target;
      if (!(target instanceof Element) || effect?.getTiming().iterations !== Infinity) continue;
      const group = targets.get(target);
      if (group) group.add(animation);
      else { targets.set(target, new Set([animation])); observer.observe(target); }
      update(target);
    }
  };
  // A burst of starting animations is looked at once per frame, not once per event.
  let cancelPending: (() => void) | null = null;
  const discoverSoon = () => {
    if (cancelPending) return;
    cancelPending = schedule(() => { cancelPending = null; discover(); });
  };
  const onVisibility = () => { discover(); for (const target of targets.keys()) update(target); };
  const removed = new MutationObserver(() => {
    for (const [target, animations] of targets) if (!target.isConnected) {
      for (const animation of animations) paused.delete(animation);
      observer.unobserve(target); targets.delete(target); visible.delete(target);
    }
  });
  removed.observe(document, { childList: true, subtree: true });
  document.addEventListener('animationstart', discoverSoon, true);
  document.addEventListener('animationcancel', discoverSoon, true);
  document.addEventListener('visibilitychange', onVisibility);
  discover();
  return () => {
    document.removeEventListener('animationstart', discoverSoon, true);
    document.removeEventListener('animationcancel', discoverSoon, true);
    cancelPending?.();
    document.removeEventListener('visibilitychange', onVisibility);
    observer.disconnect(); removed.disconnect();
    for (const animation of paused) if (animation.playState === 'paused') animation.play();
    targets.clear(); visible.clear(); paused.clear();
  };
}

@Injectable({ providedIn: 'root' })
export class VisibleAnimationsService {
  constructor() {
    const document = inject(DOCUMENT);
    if (typeof document.getAnimations === 'function' && typeof IntersectionObserver !== 'undefined') {
      inject(DestroyRef).onDestroy(watchVisibleAnimations(document));
    }
  }
}
