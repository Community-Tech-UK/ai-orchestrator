import { describe, expect, it } from 'vitest';
import {
  isCaretOnFirstVisualLine,
  isCaretOnLastVisualLine,
} from '../textarea-caret-position.util';

function textarea(value: string, caret: number): HTMLTextAreaElement {
  const element = document.createElement('textarea');
  element.value = value;
  element.selectionStart = caret;
  element.selectionEnd = caret;
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: 1000 });
  return element;
}

describe('textarea caret-position utilities', () => {
  it('detects the first logical line', () => {
    expect(isCaretOnFirstVisualLine(textarea('hello\nworld', 0))).toBe(true);
    expect(isCaretOnFirstVisualLine(textarea('hello\nworld', 7))).toBe(false);
  });

  it('detects when caret is not on the first visual line of a wrapped line', () => {
    const element = textarea('abcdefghijklmnopqrstuvwxyz', 20);
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: 60 });

    expect(isCaretOnFirstVisualLine(element)).toBe(false);
  });

  it('detects the last logical line', () => {
    expect(isCaretOnLastVisualLine(textarea('hello\nworld', 11))).toBe(true);
    expect(isCaretOnLastVisualLine(textarea('hello\nworld', 1))).toBe(false);
  });

  it('rejects non-collapsed selections', () => {
    const element = textarea('hello', 1);
    element.selectionEnd = 3;

    expect(isCaretOnFirstVisualLine(element)).toBe(false);
    expect(isCaretOnLastVisualLine(element)).toBe(false);
  });
});
