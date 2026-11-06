import type { OutputMessage, InstanceStatus } from '../../core/state/instance/instance.types';

const SELECTED_ROWS = 'button[data-pick-row][aria-pressed="true"]';

function pickedText(button: HTMLButtonElement): string {
  try {
    const text: unknown = JSON.parse(button.dataset['pickText'] ?? '');
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/** Build a bounded note from the current table's selection, preserving authored IDs and table order. */
export function buildPickedRowsText(table: HTMLTableElement): string {
  const selected = Array.from(table.querySelectorAll<HTMLButtonElement>(SELECTED_ROWS));
  if (selected.length === 0) return '';
  const numbers = selected.map((button) => button.dataset['pickRow'] ?? '');
  const list = numbers.length < 2 ? numbers[0] : `${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
  const text = [
    `${numbers.length === 1 ? 'Row' : 'Rows'} ${list} from your table:`,
    ...selected.map((button) => `- ${button.dataset['pickRow']}: ${pickedText(button)}`),
  ].join('\n');
  return text.length > 4_000 ? `${text.slice(0, 3_995)}[cut]` : text;
}

function setPicked(button: HTMLButtonElement, picked: boolean): void {
  button.setAttribute('aria-pressed', String(picked));
  button.setAttribute('aria-label', `${picked ? 'Deselect' : 'Select'} row ${button.dataset['pickRow']}`);
}

function updatePickBar(wrapper: HTMLElement, table: HTMLTableElement): void {
  const count = table.querySelectorAll(SELECTED_ROWS).length;
  const bar = wrapper.querySelector<HTMLElement>('[data-pick-bar]');
  bar?.setAttribute('data-pick-count', String(count));
  const label = bar?.querySelector('[data-pick-count-label]');
  if (label) label.textContent = `${count} selected`;
}

/** Handle only table controls in the transcript's existing delegated listener. */
export function handleTablePickClick(event: MouseEvent, append: (text: string) => void): boolean {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest<HTMLButtonElement>('button[data-pick-row], button[data-pick-add]');
  const wrapper = button?.closest<HTMLElement>('.table-wrapper');
  const table = wrapper?.querySelector('table');
  if (!button || !wrapper || !table) return false;
  event.preventDefault();
  event.stopPropagation();
  const markdown = wrapper.closest('.markdown-content');
  if (!markdown?.classList.contains('md-row-picking-enabled')
    || wrapper.closest('.md-row-picking-disabled, app-thought-process, app-system-event-group')) return true;
  if (button.hasAttribute('data-pick-row')) {
    setPicked(button, button.getAttribute('aria-pressed') !== 'true');
    updatePickBar(wrapper, table);
  } else {
    const text = buildPickedRowsText(table);
    if (text) {
      // The Add button disappears with the selection. Keep keyboard users in the table.
      if (button === button.ownerDocument.activeElement) {
        table.querySelector<HTMLButtonElement>(SELECTED_ROWS)?.focus();
      }
      table.querySelectorAll<HTMLButtonElement>(SELECTED_ROWS).forEach((pick) => setPicked(pick, false));
      updatePickBar(wrapper, table);
      append(text);
    }
  }
  return true;
}

/** Some local providers leave streaming=true after the final delta; wait for a settled session then. */
export function canPickTableRows(message: OutputMessage, status?: InstanceStatus): boolean {
  return message.type === 'assistant' && (message.metadata?.['streaming'] !== true
    || ['idle', 'ready', 'hibernated', 'terminated'].includes(status ?? ''));
}

/** Row picks need a working composer destination and a settled message. */
export function tablePicksDisabled(
  message: OutputMessage,
  picksToComposer: boolean,
  status?: InstanceStatus,
): boolean {
  return !picksToComposer || !canPickTableRows(message, status);
}
