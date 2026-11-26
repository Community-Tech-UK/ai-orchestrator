import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { HookRule } from '../../../../shared/types/hook.types';
import { HooksConfigComponent } from './hooks-config.component';

const rule = (id: string, name: string, source: HookRule['source']): HookRule => ({
  id, name, source, enabled: true, event: 'PreToolUse', conditions: [],
  action: 'warn', message: '', createdAt: 100, updatedAt: 100,
});

describe('hook toggle accessible names', () => {
  it('names each rule toggle with that rule’s visible name and names the form toggle', () => {
    TestBed.configureTestingModule({ imports: [HooksConfigComponent] });
    const fixture = TestBed.createComponent(HooksConfigComponent);
    const builtIn = rule('builtin', 'Check project files', 'built-in');
    const custom = rule('custom', 'Review shell commands', 'user');
    fixture.componentRef.setInput('hooks', [builtIn, custom]);
    fixture.componentRef.setInput('builtInRules', [builtIn]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const names = (): (string | undefined)[] => [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(field => {
      const id = field.getAttribute('aria-labelledby');
      return id ? root.querySelector(`[id="${id}"]`)?.textContent?.trim() : undefined;
    });
    expect(names()).toEqual(['Check project files', 'Review shell commands']);

    fixture.componentRef.setInput('hooks', [builtIn, { ...custom, name: 'Review changed files' }]);
    fixture.componentInstance.startCreate();
    fixture.detectChanges();
    expect(names()).toEqual(['Check project files', 'Review changed files', 'Enabled']);
    fixture.destroy();
  });
});
