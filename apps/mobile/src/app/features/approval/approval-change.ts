import type { MobilePromptDto } from '../../core/models';

/** The raw supplied contents, without the line-diff preview's line or context caps. */
export function availableChangeSections(prompt: MobilePromptDto): { label: string; content: string }[] {
  const args = prompt.toolInput;
  if (!args) return [];
  const sections: { label: string; content: string }[] = [];
  const addEdit = (edit: Record<string, unknown>, label: string): void => {
    if (typeof edit['old_string'] === 'string') sections.push({ label: `${label} · Before`, content: edit['old_string'] });
    if (typeof edit['new_string'] === 'string') sections.push({ label: `${label} · After`, content: edit['new_string'] });
  };
  const path = typeof args['file_path'] === 'string' ? args['file_path'] : 'Change';
  addEdit(args, path);
  if (typeof args['content'] === 'string') sections.push({ label: path, content: args['content'] });
  if (Array.isArray(args['edits'])) {
    args['edits'].forEach((edit: unknown, index: number) => {
      if (edit && typeof edit === 'object') addEdit(edit as Record<string, unknown>, `${path} · Edit ${index + 1}`);
    });
  }
  // Include flags and unfamiliar fields too: the approval must expose everything supplied.
  sections.push({ label: 'All action details', content: JSON.stringify(args, null, 2) });
  return sections;
}
