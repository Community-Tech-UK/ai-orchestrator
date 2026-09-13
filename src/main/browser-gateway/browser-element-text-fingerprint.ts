import type { Page } from 'puppeteer-core';

/** Returns a private full-text comparison token without returning the text from the page. */
export function fingerprintBrowserElementText(
  page: Pick<Page, '$eval'>,
  selector: string,
): Promise<string> {
  return page.$eval(selector, async (element) => {
    const node = element as { innerText?: unknown; textContent?: string | null };
    const visibleText = typeof node.innerText === 'string' ? node.innerText : node.textContent;
    const value = (visibleText ?? '').trim();
    const words = [
      value.length >>> 0, Math.floor(value.length / 0x1_0000_0000) >>> 0,
      0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35,
    ];
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      words[2] = Math.imul(words[2]! ^ code, 0x01000193) >>> 0;
      words[3] = Math.imul(words[3]! ^ (code + index), 0x85ebca6b) >>> 0;
      words[4] = Math.imul(words[4]! ^ (code + (index >>> 16)), 0xc2b2ae35) >>> 0;
      words[5] = Math.imul(
        words[5]! ^ (code + Math.imul(index + 1, 0x9e3779b1)), 0x27d4eb2d,
      ) >>> 0;
    }
    words.push((words[2]! ^ words[4]!) >>> 0, (words[3]! ^ words[5]!) >>> 0);
    return words.map((word) => word.toString(16).padStart(8, '0')).join('');
  });
}
