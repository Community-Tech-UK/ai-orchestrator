/** Put recalled or restored text in the composer textarea, caret at the end, focused. */
export function setTextareaValueAtEnd(textarea: HTMLTextAreaElement, value: string): void {
  textarea.value = value;
  textarea.selectionStart = value.length;
  textarea.selectionEnd = value.length;
  textarea.focus();
}
