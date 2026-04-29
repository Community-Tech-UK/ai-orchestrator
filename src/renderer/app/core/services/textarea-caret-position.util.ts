function getLineBounds(value: string, caret: number): { lineStart: number; lineEnd: number } {
  const lineStart = value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const nextNewline = value.indexOf('\n', caret);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  return { lineStart, lineEnd };
}

function getApproxColumns(textarea: HTMLTextAreaElement): number {
  const style = getComputedStyle(textarea);
  const fontSize = Number.parseFloat(style.fontSize || '14') || 14;
  const charWidth = Math.max(6, fontSize * 0.55);
  const horizontalPadding =
    (Number.parseFloat(style.paddingLeft || '0') || 0) +
    (Number.parseFloat(style.paddingRight || '0') || 0);
  const width = textarea.clientWidth || textarea.offsetWidth || 0;

  if (width <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(1, Math.floor((width - horizontalPadding) / charWidth));
}

export function isCaretOnFirstVisualLine(textarea: HTMLTextAreaElement): boolean {
  const caret = textarea.selectionStart;
  if (caret !== textarea.selectionEnd) {
    return false;
  }

  const { lineStart } = getLineBounds(textarea.value, caret);
  if (lineStart !== 0) {
    return false;
  }
  const column = caret - lineStart;
  return column < getApproxColumns(textarea);
}

export function isCaretOnLastVisualLine(textarea: HTMLTextAreaElement): boolean {
  const caret = textarea.selectionStart;
  if (caret !== textarea.selectionEnd) {
    return false;
  }

  const { lineStart, lineEnd } = getLineBounds(textarea.value, caret);
  if (lineEnd !== textarea.value.length) {
    return false;
  }
  const columns = getApproxColumns(textarea);
  const column = caret - lineStart;
  const lastVisualLineStart = Math.floor(Math.max(0, lineEnd - lineStart) / columns) * columns;
  return column >= lastVisualLineStart;
}
