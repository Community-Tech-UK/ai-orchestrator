import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HybridSearchOptions, HybridSearchResult } from '../../../../shared/types/codebase.types';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import { HistoryStore } from '../../core/state/history.store';
import {
  ComposerAutocompleteComponent,
  applyComposerCompletion,
  detectComposerCompletion,
  type ComposerCompletionQuery,
} from './composer-autocomplete';

describe('detectComposerCompletion', () => {
  it('detects the one-token session prefix and inserts a permission chip', () => {
    const text = 'Ask @session:fix';
    const query = detectComposerCompletion(text, text.length)!;
    expect(query.kind).toBe('session');
    expect(query.query).toBe('fix');
    expect(applyComposerCompletion(text, query, { kind: 'session', label: 'Fix', insertText: '[session: Fix · target]' }).text).toBe('Ask [session: Fix · target] ');
    expect(detectComposerCompletion('@session fix', 8)?.kind).toBe('file');
    expect(detectComposerCompletion('@session:', 9)?.kind).toBe('session');
  });
  it('detects a leading slash-command query', () => {
    expect(detectComposerCompletion('/review', '/review'.length)).toEqual({
      kind: 'slash-command',
      query: 'review',
      start: 0,
      end: 7,
    });
  });

  it('detects file and path queries introduced by @', () => {
    expect(detectComposerCompletion('Open @file', 'Open @file'.length)).toEqual({
      kind: 'file',
      query: 'file',
      start: 5,
      end: 10,
    });
    expect(detectComposerCompletion('Open @src/main/foo', 'Open @src/main/foo'.length)).toEqual({
      kind: 'file',
      query: 'src/main/foo',
      start: 5,
      end: 18,
    });
  });

  it('does not treat email addresses as file completions', () => {
    expect(detectComposerCompletion('Email me@example.com', 'Email me@example.com'.length)).toBeNull();
  });

  it('replaces the active token and places the cursor after the inserted file reference', () => {
    const query: ComposerCompletionQuery = {
      kind: 'file',
      query: 'src/ma',
      start: 'Inspect '.length,
      end: 'Inspect @src/ma'.length,
    };

    const result = applyComposerCompletion('Inspect @src/ma', query, {
      kind: 'file',
      label: 'src/main/input-panel.component.ts',
      insertText: 'src/main/input-panel.component.ts',
      detail: 'TypeScript',
    });

    expect(result).toEqual({
      text: 'Inspect @src/main/input-panel.component.ts ',
      cursor: 'Inspect @src/main/input-panel.component.ts '.length,
    });
  });
});

class FakeCodebaseIpcService {
  search = vi.fn<(
    options: HybridSearchOptions,
  ) => Promise<{ success: true; data: HybridSearchResult[] }>>();
}

@Component({
  standalone: true,
  imports: [ComposerAutocompleteComponent],
  template: `
    <textarea #textarea></textarea>
    <app-composer-autocomplete
      [textarea]="textarea"
      [workspaceCwd]="workspaceCwd"
    />
  `,
})
class ComposerAutocompleteHostComponent {
  workspaceCwd = '/repo';
}

describe('ComposerAutocompleteComponent', () => {
  let fixture: ComponentFixture<ComposerAutocompleteHostComponent>;
  let fakeCodebase: FakeCodebaseIpcService;

  beforeEach(async () => {
    fakeCodebase = new FakeCodebaseIpcService();
    fakeCodebase.search.mockResolvedValue({
      success: true,
      data: [
        searchResult('/repo/src/main/input-panel.component.ts', 20),
        searchResult('/repo/src/renderer/app/shared/utils/focus-trap.ts', 10),
      ],
    });

    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ComposerAutocompleteHostComponent],
      providers: [
        { provide: CodebaseIpcService, useValue: fakeCodebase },
        { provide: InstanceStore, useValue: { instances: signal([{ id: 'same', displayName: 'Fix same project', workingDirectory: '/repo' }]) } },
        { provide: HistoryStore, useValue: { entries: signal([{ id: 'other', displayName: 'Fix other project', originalInstanceId: 'past-other', workingDirectory: '/elsewhere' }]), loading: signal(false) } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ComposerAutocompleteHostComponent);
    fixture.detectChanges();
  });

  it('opens file-backed fuzzy suggestions for @ queries', async () => {
    const textarea = getTextarea(fixture);

    await typeInTextarea(fixture, textarea, 'Please inspect @src/mai');

    expect(fakeCodebase.search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'src/mai',
      storeId: 'default',
      workspacePath: '/repo',
      topK: 24,
    }));

    const items = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.composer-completion-item'),
    );
    expect(items.map(item => item.textContent)).toEqual([
      expect.stringContaining('src/main/input-panel.component.ts'),
    ]);
  });

  it('offers live and history session chips with the current project first', async () => {
    const textarea = getTextarea(fixture);
    await typeInTextarea(fixture, textarea, 'Ask @session:fix');
    const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.composer-completion-item'));
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('Fix same project');
    expect(buttons[1].textContent).toContain('Read on request only');
    buttons[1].click();
    fixture.detectChanges();
    expect(textarea.value).toBe('Ask [session: Fix other project · other] ');
    expect(fakeCodebase.search).not.toHaveBeenCalled();
  });

  it('accepts the selected completion from the keyboard while preserving textarea focus', async () => {
    const textarea = getTextarea(fixture);
    const inputEvents: string[] = [];
    textarea.addEventListener('input', () => inputEvents.push(textarea.value));

    await typeInTextarea(fixture, textarea, 'Please inspect @src');
    const arrowDown = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    expect(textarea.dispatchEvent(arrowDown)).toBe(false);
    fixture.detectChanges();

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    expect(textarea.dispatchEvent(tab)).toBe(false);
    fixture.detectChanges();

    expect(textarea.value).toBe('Please inspect @src/renderer/app/shared/utils/focus-trap.ts ');
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(inputEvents.at(-1)).toBe(textarea.value);
    expect(document.activeElement).toBe(textarea);
    expect(fixture.nativeElement.querySelector('.composer-completions')).toBeNull();
  });

  it('accepts with Enter, wraps ArrowUp, and closes with Escape', async () => {
    const textarea = getTextarea(fixture);

    await typeInTextarea(fixture, textarea, 'Please inspect @src');
    const arrowUp = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    expect(textarea.dispatchEvent(arrowUp)).toBe(false);
    fixture.detectChanges();

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    expect(textarea.dispatchEvent(enter)).toBe(false);
    fixture.detectChanges();

    expect(textarea.value).toBe('Please inspect @src/renderer/app/shared/utils/focus-trap.ts ');

    await typeInTextarea(fixture, textarea, 'Please inspect @src');
    expect(fixture.nativeElement.querySelector('.composer-completions')).not.toBeNull();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    expect(textarea.dispatchEvent(escape)).toBe(false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.composer-completions')).toBeNull();
  });

  it('closes suggestions when the textarea loses focus', async () => {
    const textarea = getTextarea(fixture);

    await typeInTextarea(fixture, textarea, 'Please inspect @src');
    expect(fixture.nativeElement.querySelector('.composer-completions')).not.toBeNull();

    textarea.dispatchEvent(new FocusEvent('blur'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.composer-completions')).toBeNull();
  });

  it('does not consume Enter when no completion menu is open', () => {
    const textarea = getTextarea(fixture);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });

    expect(textarea.dispatchEvent(enter)).toBe(true);
  });
});

function getTextarea(fixture: ComponentFixture<ComposerAutocompleteHostComponent>): HTMLTextAreaElement {
  return fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
}

async function typeInTextarea(
  fixture: ComponentFixture<ComposerAutocompleteHostComponent>,
  textarea: HTMLTextAreaElement,
  value: string,
): Promise<void> {
  textarea.focus();
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 130));
  await fixture.whenStable();
  await Promise.resolve();
  fixture.detectChanges();
}

function searchResult(filePath: string, score: number): HybridSearchResult {
  return {
    sectionId: `${filePath}:1:1`,
    filePath,
    content: '',
    startLine: 1,
    endLine: 1,
    score,
    matchType: 'bm25',
    language: 'typescript',
  };
}
