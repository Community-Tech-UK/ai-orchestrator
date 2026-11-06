import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../core/state/instance.store';
import { ChildSessionNavComponent } from './child-session-nav.component';
describe('Child session navigation', () => {
  it('orders siblings by creation and navigates without using parent childrenIds', () => {
    const instances = signal([{ id: 'parent', displayName: 'Foo', parentId: null, createdAt: 0, childrenIds: ['wrong'] },
      ...[5, 3, 1, 4, 2].map((n) => ({ id: `child-${n}`, displayName: `Child ${n}`, parentId: 'parent', createdAt: n, childrenIds: [] }))]);
    const select = vi.fn();
    TestBed.configureTestingModule({ imports: [ChildSessionNavComponent], providers: [{ provide: InstanceStore, useValue: { instances, setSelectedInstance: select } }] });
    const fixture = TestBed.createComponent(ChildSessionNavComponent);
    fixture.componentRef.setInput('instanceId', 'child-2'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Child 2 of 5 of Foo');
    const buttons = () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
    buttons()[0].click(); expect(select).toHaveBeenLastCalledWith('parent');
    buttons()[1].click(); expect(select).toHaveBeenLastCalledWith('child-1');
    buttons()[2].click(); expect(select).toHaveBeenLastCalledWith('child-3');
    fixture.componentRef.setInput('instanceId', 'child-1'); fixture.detectChanges();
    expect(buttons()[1].disabled).toBe(true); expect(fixture.nativeElement.textContent).toContain('First child');
    fixture.componentRef.setInput('instanceId', 'child-5'); fixture.detectChanges();
    expect(buttons()[2].disabled).toBe(true); expect(fixture.nativeElement.textContent).toContain('Last child');
    fixture.componentRef.setInput('instanceId', 'parent'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('nav')).toBeNull();
    fixture.destroy();
  });
});
