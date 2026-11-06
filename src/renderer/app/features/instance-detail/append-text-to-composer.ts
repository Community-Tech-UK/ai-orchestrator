import type { InputPanelComponent } from './input-panel.component';

/** Reuse the composer's non-overwriting restore path and leave submission to the user. */
export function appendTextToComposer(panel: Pick<InputPanelComponent, 'restoreTextToComposer'> | undefined, text: string): void {
  if (text.trim()) panel?.restoreTextToComposer(text, 'append');
}
