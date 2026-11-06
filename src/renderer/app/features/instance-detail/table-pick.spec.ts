import { describe, expect, it } from 'vitest';
import { buildPickedRowsText, canPickTableRows, handleTablePickClick } from './table-pick';

function tableFixture(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrapper markdown-content md-row-picking-enabled';
  wrapper.innerHTML = `<table><tbody>${[1, 3, 5].map((row) => `<tr><td><button type="button" data-pick-row="${row}" data-pick-text="&quot;Finding: Item ${row}&quot;" aria-pressed="false"><span></span></button></td></tr>`).join('')}</tbody></table>
    <div data-pick-bar data-pick-count="0"><span data-pick-count-label></span><button type="button" data-pick-add><span>Add to reply</span></button></div>`;
  return wrapper;
}

describe('picked table rows', () => {
  it('builds the authored row numbers and summaries in table order', () => {
    const wrapper = tableFixture();
    wrapper.querySelectorAll('[data-pick-row]').forEach((button) => button.setAttribute('aria-pressed', 'true'));
    expect(buildPickedRowsText(wrapper.querySelector('table')!)).toBe(
      'Rows 1, 3 and 5 from your table:\n- 1: Finding: Item 1\n- 3: Finding: Item 3\n- 5: Finding: Item 5',
    );
  });

  it('returns empty text for an empty selection', () => {
    expect(buildPickedRowsText(tableFixture().querySelector('table')!)).toBe('');
  });

  it('caps inserted text at 4000 characters including a visible cut marker', () => {
    const wrapper = tableFixture();
    const pick = wrapper.querySelector('[data-pick-row]')!;
    pick.setAttribute('aria-pressed', 'true');
    pick.setAttribute('data-pick-text', JSON.stringify('x'.repeat(5_000)));
    const text = buildPickedRowsText(wrapper.querySelector('table')!);
    expect(text).toHaveLength(4_000);
    expect(text.endsWith('[cut]')).toBe(true);
  });

  it('toggles picks, announces the count, and adds one note before clearing selection', () => {
    const wrapper = tableFixture();
    const notes: string[] = [];
    wrapper.addEventListener('click', (event) => handleTablePickClick(event as MouseEvent, (text) => notes.push(text)));
    const pick = wrapper.querySelector<HTMLButtonElement>('[data-pick-row="1"]')!;
    pick.querySelector<HTMLElement>('span')!.click();
    expect(pick.getAttribute('aria-pressed')).toBe('true');
    expect(pick.getAttribute('aria-label')).toBe('Deselect row 1');
    expect(wrapper.querySelector('[data-pick-bar]')?.getAttribute('data-pick-count')).toBe('1');
    expect(wrapper.querySelector('[data-pick-count-label]')?.textContent).toBe('1 selected');
    wrapper.querySelector<HTMLButtonElement>('[data-pick-add] span')!.click();
    expect(notes).toEqual(['Row 1 from your table:\n- 1: Finding: Item 1']);
    expect(pick.getAttribute('aria-pressed')).toBe('false');
    wrapper.querySelector<HTMLButtonElement>('[data-pick-add]')!.click();
    expect(notes).toHaveLength(1);
  });

  it('does not act on hidden streaming or non-assistant table controls', () => {
    const wrapper = tableFixture();
    wrapper.classList.add('md-row-picking-disabled');
    const notes: string[] = [];
    wrapper.addEventListener('click', (event) => handleTablePickClick(event as MouseEvent, (text) => notes.push(text)));
    wrapper.querySelector<HTMLButtonElement>('[data-pick-row]')!.click();
    expect(wrapper.querySelector('[data-pick-row]')?.getAttribute('aria-pressed')).toBe('false');
    expect(notes).toEqual([]);
  });

  it('requires an explicit reply opt-in before toggling or appending', () => {
    const wrapper = tableFixture();
    wrapper.classList.remove('md-row-picking-enabled');
    const notes: string[] = [];
    wrapper.addEventListener('click', (event) => handleTablePickClick(event as MouseEvent, (text) => notes.push(text)));
    const pick = wrapper.querySelector<HTMLButtonElement>('[data-pick-row]')!;
    pick.click();
    expect(pick.getAttribute('aria-pressed')).toBe('false');
    // A stale selection must not bypass the gate through the Add button.
    pick.setAttribute('aria-pressed', 'true');
    wrapper.querySelector<HTMLButtonElement>('[data-pick-add]')!.click();
    expect(notes).toEqual([]);
  });

  it('does not inherit reply opt-in through a nested Markdown container', () => {
    const root = document.createElement('div');
    root.className = 'markdown-content md-row-picking-enabled';
    const nested = tableFixture();
    nested.classList.remove('md-row-picking-enabled');
    root.append(nested);
    const notes: string[] = [];
    root.addEventListener('click', (event) => handleTablePickClick(event as MouseEvent, (text) => notes.push(text)));
    nested.querySelector<HTMLButtonElement>('[data-pick-row]')!.click();
    nested.querySelector<HTMLButtonElement>('[data-pick-add]')!.click();
    expect(nested.querySelector('[data-pick-row]')?.getAttribute('aria-pressed')).toBe('false');
    expect(notes).toEqual([]);
  });

  it('toggles a selected row off and hides its action bar again', () => {
    const wrapper = tableFixture();
    wrapper.addEventListener('click', (event) => handleTablePickClick(event as MouseEvent, () => undefined));
    const pick = wrapper.querySelector<HTMLButtonElement>('[data-pick-row]')!;
    pick.click();
    pick.click();
    expect(pick.getAttribute('aria-pressed')).toBe('false');
    expect(wrapper.querySelector('[data-pick-bar]')?.getAttribute('data-pick-count')).toBe('0');
  });

  it('isolates selections to their own table', () => {
    const root = document.createElement('div');
    const first = tableFixture();
    const second = tableFixture();
    root.append(first, second);
    const notes: string[] = [];
    root.addEventListener('click', (event) => handleTablePickClick(event as MouseEvent, (text) => notes.push(text)));
    first.querySelector<HTMLButtonElement>('[data-pick-row="1"]')!.click();
    second.querySelector<HTMLButtonElement>('[data-pick-add]')!.click();
    expect(notes).toEqual([]);
    first.querySelector<HTMLButtonElement>('[data-pick-add]')!.click();
    expect(notes).toEqual(['Row 1 from your table:\n- 1: Finding: Item 1']);
  });

  it('returns focus to a row control before hiding the focused Add button', () => {
    const wrapper = tableFixture();
    document.body.append(wrapper);
    try {
      wrapper.addEventListener('click', (event) => handleTablePickClick(event as MouseEvent, () => undefined));
      const pick = wrapper.querySelector<HTMLButtonElement>('[data-pick-row="3"]')!;
      pick.click();
      const add = wrapper.querySelector<HTMLButtonElement>('[data-pick-add]')!;
      add.focus();
      add.click();
      expect(document.activeElement).toBe(pick);
      expect(wrapper.querySelector('[data-pick-bar]')?.getAttribute('data-pick-count')).toBe('0');
    } finally { wrapper.remove(); }
  });
});

describe('completed table guard', () => {
  const reply = { id: 'reply', timestamp: 1, type: 'assistant' as const, content: '' };
  it('permits completed assistant replies but excludes user content', () => {
    expect(canPickTableRows(reply, 'busy')).toBe(true);
    expect(canPickTableRows({ ...reply, type: 'user' }, 'idle')).toBe(false);
  });

  it('waits for streaming to finish, allowing stale streaming markers only after the session settles', () => {
    const streamed = { ...reply, metadata: { streaming: true } };
    expect(canPickTableRows(streamed, 'busy')).toBe(false);
    expect(canPickTableRows(streamed, 'waiting_for_permission')).toBe(false);
    expect(canPickTableRows(streamed)).toBe(false);
    expect(canPickTableRows(streamed, 'idle')).toBe(true);
    expect(canPickTableRows({ ...streamed, metadata: { streaming: false } }, 'busy')).toBe(true);
  });
});
