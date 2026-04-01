import { describe, expect, it } from 'vitest';
import {
  createAbortController,
  createChildAbortController,
} from '../abort-controller-tree';

describe('AbortControllerTree', () => {
  describe('createAbortController', () => {
    it('returns a standard AbortController', () => {
      const ac = createAbortController();
      expect(ac.signal.aborted).toBe(false);
      ac.abort();
      expect(ac.signal.aborted).toBe(true);
    });
  });

  describe('createChildAbortController', () => {
    it('child aborts when parent aborts', () => {
      const parent = createAbortController();
      const child = createChildAbortController(parent);

      expect(child.signal.aborted).toBe(false);
      parent.abort();
      expect(child.signal.aborted).toBe(true);
    });

    it('parent does NOT abort when child aborts', () => {
      const parent = createAbortController();
      const child = createChildAbortController(parent);

      child.abort();
      expect(child.signal.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false);
    });

    it('propagates abort reason from parent to child', () => {
      const parent = createAbortController();
      const child = createChildAbortController(parent);

      parent.abort('timeout');
      expect(child.signal.reason).toBe('timeout');
    });

    it('cleans up parent listener when child is aborted independently', () => {
      const parent = createAbortController();
      const child = createChildAbortController(parent);

      child.abort('done');
      // After child abort, parent aborting should not throw or leak
      parent.abort();
      expect(parent.signal.aborted).toBe(true);
    });

    it('supports multiple children', () => {
      const parent = createAbortController();
      const child1 = createChildAbortController(parent);
      const child2 = createChildAbortController(parent);
      const child3 = createChildAbortController(parent);

      parent.abort();
      expect(child1.signal.aborted).toBe(true);
      expect(child2.signal.aborted).toBe(true);
      expect(child3.signal.aborted).toBe(true);
    });

    it('supports grandchild hierarchy', () => {
      const root = createAbortController();
      const child = createChildAbortController(root);
      const grandchild = createChildAbortController(child);

      root.abort();
      expect(child.signal.aborted).toBe(true);
      expect(grandchild.signal.aborted).toBe(true);
    });

    it('does not affect siblings when one child aborts', () => {
      const parent = createAbortController();
      const child1 = createChildAbortController(parent);
      const child2 = createChildAbortController(parent);

      child1.abort();
      expect(child1.signal.aborted).toBe(true);
      expect(child2.signal.aborted).toBe(false);
      expect(parent.signal.aborted).toBe(false);
    });

    it('handles already-aborted parent', () => {
      const parent = createAbortController();
      parent.abort('already');
      const child = createChildAbortController(parent);
      expect(child.signal.aborted).toBe(true);
      expect(child.signal.reason).toBe('already');
    });
  });
});
