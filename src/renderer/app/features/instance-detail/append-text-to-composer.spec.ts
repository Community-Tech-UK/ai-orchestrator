import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { InputPanelComponent } from './input-panel.component';
import { appendTextToComposer } from './append-text-to-composer';

function composerFixture(text: string, recalledDraft = '', editDraft: string | null = null): InputPanelComponent {
  const drafts = new Map<string, string>([['stash-chat', recalledDraft]]);
  return Object.assign(Object.create(InputPanelComponent.prototype), {
    message: signal(text),
    stashedDraft: signal(editDraft),
    editMode: signal(editDraft !== null),
    editMessageIndex: signal(editDraft !== null ? 1 : null),
    showCommandSuggestions: signal(false),
    slashResolution: signal(null),
    recallIndex: signal(recalledDraft ? 1 : null),
    recalledEntryId: signal(recalledDraft ? 'recalled' : null),
    stashKey: () => 'stash-chat',
    draftService: { getDraft: (key: string) => drafts.get(key) ?? '', clearDraft: (key: string) => drafts.delete(key) },
    persistComposerText: (value: string) => drafts.set('chat', value),
    syncTextareaValue: () => undefined,
  }) as InputPanelComponent;
}

describe('appendTextToComposer', () => {
  it('appends selected rows after the existing draft without submitting it', () => {
    const panel = composerFixture('Already typed text');
    appendTextToComposer(panel, 'Rows 1 and 3 from your table');
    expect(panel.message()).toBe('Already typed text\n\nRows 1 and 3 from your table');
  });

  it('preserves the hidden draft during prompt-history recall', () => {
    const panel = composerFixture('Recalled prompt', 'Unsaved draft');
    appendTextToComposer(panel, 'Row 1 from your table');
    expect(panel.message()).toContain('Recalled prompt');
    expect(panel.message()).toContain('Unsaved draft');
    expect(panel.message().endsWith('Row 1 from your table')).toBe(true);
  });

  it('preserves the draft stashed while editing a previous message', () => {
    const panel = composerFixture('Edited previous question', '', 'Draft before edit');
    appendTextToComposer(panel, 'Row 3 from your table');
    expect(panel.message()).toContain('Edited previous question');
    expect(panel.message()).toContain('Draft before edit');
    expect(panel.message().endsWith('Row 3 from your table')).toBe(true);
  });

  it('ignores an empty selection and tolerates a missing composer', () => {
    const panel = composerFixture('Untouched');
    appendTextToComposer(panel, '');
    expect(panel.message()).toBe('Untouched');
    expect(() => appendTextToComposer(undefined, 'Rows selected')).not.toThrow();
  });
});
