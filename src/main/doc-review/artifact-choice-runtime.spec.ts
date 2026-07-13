import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const TEMPLATE_PATH = join(__dirname, 'assets', 'artifact-template.html');
const template = readFileSync(TEMPLATE_PATH, 'utf8');

interface EmbeddedArtifact {
  dom: JSDOM;
  messages: unknown[];
  parent: { postMessage(message: unknown): void };
}

function renderEmbeddedArtifact(content: string): EmbeddedArtifact {
  const messages: unknown[] = [];
  const parent = { postMessage: (message: unknown): void => { messages.push(message); } };
  const html = template
    .replace(/\{\{TITLE\}\}/g, 'Choice test')
    .replace(/\{\{SOURCE\}\}/g, '')
    .replace(/\{\{REVIEW_ID\}\}/g, 'choice-test')
    .replace(/\{\{GENERATED_AT\}\}/g, '2026-07-13')
    .replace('{{CONTENT}}', content);
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      Object.defineProperty(window, 'parent', { configurable: true, value: parent });
    },
  });
  return { dom, messages, parent };
}

function click(element: Element): void {
  element.dispatchEvent(new element.ownerDocument.defaultView!.MouseEvent('click', { bubbles: true }));
}

function messagesOfType(messages: unknown[], type: string): Array<Record<string, unknown>> {
  return messages.filter((message): message is Record<string, unknown> => (
    typeof message === 'object'
    && message !== null
    && (message as Record<string, unknown>)['type'] === type
  ));
}

describe('doc-review artifact choice runtime', () => {
  it('renders radios with a default marker and selecting one implies approval', () => {
    const { dom, messages } = renderEmbeddedArtifact(`
      <section data-review-item="strategy" data-review-title="Strategy" data-decision-id="1">
        <ul data-review-options data-multi="false">
          <li data-option="a" data-option-default="true">Loop only</li>
          <li data-option="b">Loop and chat</li>
        </ul>
      </section>
    `);
    const { document } = dom.window;

    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((radio) => radio.value)).toEqual(['a', 'b']);
    expect(document.querySelector('.rv-option-default')?.textContent).toBe('(default)');
    expect(messagesOfType(messages, 'aio-review/ready')).toContainEqual(expect.objectContaining({
      items: [expect.objectContaining({
        id: 'strategy',
        options: [
          expect.objectContaining({ id: 'a', multi: false, isDefault: true }),
          expect.objectContaining({ id: 'b', multi: false, isDefault: false }),
        ],
      })],
    }));

    click(radios[1]);

    expect(document.querySelector('[data-choice="approve"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(messagesOfType(messages, 'aio-review/choice').at(-1)).toMatchObject({
      itemId: 'strategy', choice: 'b', choices: [],
    });
  });

  it('renders multi-select choices as checkboxes and preserves all selected values', () => {
    const { dom, messages } = renderEmbeddedArtifact(`
      <section data-review-item="scope" data-review-title="Scope">
        <ul data-review-options data-multi="true">
          <li data-option="a">Tests</li>
          <li data-option="b">Documentation</li>
        </ul>
      </section>
    `);
    const { document } = dom.window;
    const checkboxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));

    expect(checkboxes.map((checkbox) => checkbox.value)).toEqual(['a', 'b']);
    click(checkboxes[0]);
    click(checkboxes[1]);

    expect(document.querySelector('[data-choice="approve"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(messagesOfType(messages, 'aio-review/choice').at(-1)).toMatchObject({
      itemId: 'scope', choice: null, choices: ['a', 'b'],
    });
  });

  it('keeps Reject authoritative and restores stored choice state through the embedded bridge', () => {
    const { dom, messages, parent } = renderEmbeddedArtifact(`
      <section data-review-item="strategy" data-review-title="Strategy">
        <ul data-review-options data-multi="false">
          <li data-option="a">Loop only</li>
          <li data-option="b">Loop and chat</li>
        </ul>
      </section>
    `);
    const { document } = dom.window;
    const radio = document.querySelector<HTMLInputElement>('input[value="b"]')!;

    click(document.querySelector('[data-choice="reject"]')!);
    click(radio);

    expect(document.querySelector('[data-choice="reject"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(messagesOfType(messages, 'aio-review/decision').at(-1)).toMatchObject({ decision: 'reject' });
    expect(messagesOfType(messages, 'aio-review/choice').at(-1)).toMatchObject({ choice: 'b' });

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      source: parent,
      data: {
        type: 'aio-review/init',
        comments: [{ itemId: 'strategy', decision: 'approve', comment: 'restored', choice: 'a', choices: [] }],
      },
    }));

    expect(document.querySelector<HTMLInputElement>('input[value="a"]')?.checked).toBe(true);
    expect(document.querySelector('.rv-comment')?.textContent).toBe('');
    expect(document.querySelector<HTMLTextAreaElement>('.rv-comment')?.value).toBe('restored');
    expect(document.querySelector('[data-choice="approve"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps an optionless section on the established generic-control rendering path', () => {
    const { dom } = renderEmbeddedArtifact(`
      <section data-review-item="overview" data-review-title="Overview"><p>Existing review text.</p></section>
    `);

    expect(dom.window.document.querySelector('section')?.innerHTML).toMatchInlineSnapshot(`"<p>Existing review text.</p><div class="rv-item-controls"><div class="rv-toggle"><button data-choice="approve" type="button" aria-pressed="false">Approve</button><button data-choice="reject" type="button" aria-pressed="false">Reject</button></div><textarea class="rv-comment" rows="1" placeholder="Comment (optional)"></textarea></div>"`);
  });
});
