import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../state/instance.store';
import { VisibleInstanceResolver } from '../visible-instance-resolver.service';

function group(key: string, isExpanded: boolean, ids: string[]) {
  return {
    key,
    isExpanded,
    liveItems: ids.map((id) => ({ instance: { id } })),
  };
}

describe('VisibleInstanceResolver', () => {
  const instanceStore = {
    setSelectedInstance: vi.fn(),
  };

  beforeEach(() => {
    instanceStore.setSelectedInstance.mockReset();
    TestBed.configureTestingModule({
      providers: [
        VisibleInstanceResolver,
        { provide: InstanceStore, useValue: instanceStore },
      ],
    });
  });

  it('starts with an empty order', () => {
    const resolver = TestBed.inject(VisibleInstanceResolver);

    expect(resolver.getOrder().instanceIds).toEqual([]);
  });

  it('flattens expanded project groups in render order', () => {
    const source = signal([
      group('project-a', true, ['a1', 'a2']),
      group('project-b', true, ['b1']),
    ]);
    const resolver = TestBed.inject(VisibleInstanceResolver);

    resolver.setProjectGroupsSource(source);

    expect(resolver.getOrder().instanceIds).toEqual(['a1', 'a2', 'b1']);
    expect(resolver.getOrder().projectKeys).toEqual(['project-a', 'project-a', 'project-b']);
  });

  it('excludes collapsed project groups', () => {
    const source = signal([
      group('project-a', false, ['a1']),
      group('project-b', true, ['b1']),
    ]);
    const resolver = TestBed.inject(VisibleInstanceResolver);

    resolver.setProjectGroupsSource(source);

    expect(resolver.getOrder().instanceIds).toEqual(['b1']);
  });

  it('updates when the source signal changes', () => {
    const source = signal([group('project-a', true, ['a1'])]);
    const resolver = TestBed.inject(VisibleInstanceResolver);
    resolver.setProjectGroupsSource(source);

    source.set([group('project-b', true, ['b1', 'b2'])]);

    expect(resolver.getInstanceIdAt(2)).toBe('b2');
  });

  it('selects visible instances by 1-based slot', () => {
    const source = signal([group('project-a', true, ['a1', 'a2'])]);
    const resolver = TestBed.inject(VisibleInstanceResolver);
    resolver.setProjectGroupsSource(source);

    expect(resolver.selectVisibleInstance(2)).toBe(true);
    expect(instanceStore.setSelectedInstance).toHaveBeenCalledWith('a2');
    expect(resolver.selectVisibleInstance(3)).toBe(false);
  });

  it('rejects a second source to preserve a single rail owner', () => {
    const resolver = TestBed.inject(VisibleInstanceResolver);
    resolver.setProjectGroupsSource(signal([]));

    expect(() => resolver.setProjectGroupsSource(signal([]))).toThrow(/source already set/);
  });
});
