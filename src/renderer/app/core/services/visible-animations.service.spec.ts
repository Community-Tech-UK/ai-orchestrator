import { describe, expect, it, vi } from 'vitest';
import { watchVisibleAnimations } from './visible-animations.service';

describe('visible animations', () => {
  it('pauses a newly started animation on an element that is already off screen', () => {
    const target = document.createElement('div');
    document.body.append(target);
    let intersect!: IntersectionObserverCallback;
    const observer = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    const makeAnimation = () => ({
      effect: { target, getTiming: () => ({ iterations: Infinity }) },
      playState: 'running',
      pause: vi.fn(function (this: { playState: string }) { this.playState = 'paused'; }),
      play: vi.fn(function (this: { playState: string }) { this.playState = 'running'; }),
    });
    const original = makeAnimation();
    const animations = [original];
    Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => animations });
    const frames: (() => void)[] = [];
    const stop = watchVisibleAnimations(document, callback => { intersect = callback; return observer; },
      run => { frames.push(run); return () => undefined; });
    try {
      const bounds = target.getBoundingClientRect();
      intersect([{ target, isIntersecting: false, boundingClientRect: bounds, intersectionRect: bounds,
        intersectionRatio: 0, rootBounds: null, time: 0 }], observer as unknown as IntersectionObserver);
      expect(original.playState).toBe('paused');
      const added = makeAnimation();
      animations.push(added);
      target.dispatchEvent(new Event('animationstart', { bubbles: true }));
      frames.splice(0).forEach(run => run());
      expect(added.playState).toBe('paused');
      intersect([{ target, isIntersecting: true, boundingClientRect: bounds, intersectionRect: bounds,
        intersectionRatio: 1, rootBounds: null, time: 0 }], observer as unknown as IntersectionObserver);
      expect(added.playState).toBe('running');
      expect(original.playState).toBe('running');
    } finally {
      stop(); target.remove(); Reflect.deleteProperty(document, 'getAnimations');
    }
  });

  it('pauses only running infinite animations off screen and resumes only those it paused', () => {
    const target = document.createElement('div'); document.body.append(target);
    let intersect!: IntersectionObserverCallback;
    const observer = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    const createObserver = (callback: IntersectionObserverCallback) => { intersect = callback; return observer; };
    const animation = (iterations: number, playState = 'running') => ({
      effect: { target, getTiming: () => ({ iterations }) }, playState, pause: vi.fn(), play: vi.fn(),
    });
    const infinite = animation(Infinity); const finite = animation(1); const alreadyPaused = animation(Infinity, 'paused');
    Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => [infinite, finite, alreadyPaused] });
    const stop = watchVisibleAnimations(document, createObserver);
    const report = (isIntersecting: boolean) => intersect([{ target, isIntersecting,
      boundingClientRect: target.getBoundingClientRect(), intersectionRect: target.getBoundingClientRect(),
      intersectionRatio: isIntersecting ? 1 : 0, rootBounds: null, time: 0,
    }], observer as unknown as IntersectionObserver);
    report(false);
    expect(infinite.pause).toHaveBeenCalledOnce(); expect(finite.pause).not.toHaveBeenCalled(); expect(alreadyPaused.pause).not.toHaveBeenCalled();
    report(true);
    expect(infinite.play).toHaveBeenCalledOnce(); expect(alreadyPaused.play).not.toHaveBeenCalled();
    stop(); expect(observer.disconnect).toHaveBeenCalledOnce(); target.remove();
    Reflect.deleteProperty(document, 'getAnimations');
  });

  it('looks at a burst of starting animations once per frame', () => {
    const target = document.createElement('div'); document.body.append(target);
    const observer = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    const getAnimations = vi.fn(() => []);
    Object.defineProperty(document, 'getAnimations', { configurable: true, value: getAnimations });
    const frames: (() => void)[] = [];
    const cancel = vi.fn();
    const stop = watchVisibleAnimations(document, () => observer, run => { frames.push(run); return cancel; });
    try {
      getAnimations.mockClear();
      for (let index = 0; index < 5; index++) target.dispatchEvent(new Event('animationstart', { bubbles: true }));
      expect(frames).toHaveLength(1);
      expect(getAnimations).not.toHaveBeenCalled();
      frames.splice(0).forEach(run => run());
      expect(getAnimations).toHaveBeenCalledOnce();
      target.dispatchEvent(new Event('animationcancel', { bubbles: true }));
      expect(frames).toHaveLength(1);
      stop();
      expect(cancel).toHaveBeenCalledOnce();
    } finally { target.remove(); Reflect.deleteProperty(document, 'getAnimations'); }
  });
});
