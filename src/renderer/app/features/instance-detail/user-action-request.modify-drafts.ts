import { signal } from '@angular/core';

export type ModifiedInput = { input: Record<string, unknown> } | { error: string };

/** Reads the edited tool input back. It has to be a non-empty JSON object before it is sent. */
export function parseModifiedInput(raw: string): ModifiedInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { error: 'Invalid JSON — please fix the syntax before approving.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    return { error: 'Input must be a non-empty JSON object ({ … }).' };
  }
  return { input: parsed as Record<string, unknown> };
}

/** The "Edit input" panel of a held approval: whether it is open, what was typed and what is wrong with it. */
export class ModifyDrafts {
  private readonly open = new Map<string, boolean>();
  private readonly texts = new Map<string, string>();
  private readonly errors = signal(new Map<string, string>());

  isOpen(key: string): boolean {
    return this.open.get(key) ?? false;
  }

  /** Opening it for the first time fills the editor with the tool's current input. */
  toggle(key: string, toolInput: unknown): void {
    const open = !this.isOpen(key);
    this.open.set(key, open);
    if (open && !this.texts.has(key)) this.texts.set(key, toolInput ? JSON.stringify(toolInput, null, 2) : '');
  }

  text(key: string): string {
    return this.texts.get(key) ?? '';
  }

  /** Typing clears a stale error. */
  setText(key: string, value: string): void {
    this.texts.set(key, value);
    this.setError(key, undefined);
  }

  error(key: string): string {
    return this.errors().get(key) ?? '';
  }

  setError(key: string, message: string | undefined): void {
    this.errors.update((errors) => {
      const next = new Map(errors);
      if (message) next.set(key, message);
      else next.delete(key);
      return next;
    });
  }

  clear(key: string): void {
    this.open.delete(key);
    this.texts.delete(key);
    this.setError(key, undefined);
  }
}
