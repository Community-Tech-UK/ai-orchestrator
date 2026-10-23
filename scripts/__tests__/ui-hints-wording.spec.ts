import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../ui-hints/analyze';
import { checkLedger, classify, compareLedgers, recordNew, retire, tokens } from '../ui-hints/wording-ledger.js';
import { HOVER_BINDINGS, NAME_PROVIDERS, TOOLTIP_PROVIDERS } from '../ui-hints/types';
import { fixtureTree } from './ui-hints-fixtures';

describe('wording ledger preserves recorded consequences', () => {
  it('preserves visible rendering boundaries without separating contiguous static text', () => {
    const tree = fixtureTree('<button title="Delete all conversation history">Delete</button>');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []);
      const bad = [
        '<button>{{ flag ? "Delete all" : "conversation history" }}</button>',
        '<button>Delete {{ target }}all conversation history</button>',
        '<button>@if (flag) {Delete all} @else {conversation history}</button>',
        '<button>@switch (flag) {@case (1) {Delete all} @default {conversation history}}</button>',
        '<button>@for (item of items; track item) {Delete all} @empty {conversation history}</button>',
        '<button>@defer {Delete all} @placeholder {conversation history}</button>',
        '<button>Delete all</button><button>conversation history</button>',
        '<button [appTooltip]="status === \'Delete all conversation history\' ? \'Close\' : \'Refresh\'">×</button>',
        '<button [appTooltip]="status === \'Delete all conversation history\' && \'Close\'">×</button>',
        '<button [appTooltip]="status === \'Delete all conversation history\' || \'Close\'">×</button>',
        '<button><svg><title>Delete all conversation history</title></svg></button>',
        '<ng-template>Delete all conversation history</ng-template><button>Delete</button>',
      ];
      for (const html of bad) { tree.write(html); expect(checkLedger(analyze(tree.root, {}), ledger), html).not.toEqual([]); }
      const good = [
        '<button>Delete <span>all conversation</span> history</button>',
        '<button>De<span>lete all</span> conversation history</button>',
        '<button>{{ "Delete " + "all conversation history" }}</button>',
        '<button>Delete {{ "all" }} conversation history</button>',
        '<button>{{ flag ? "Delete all conversation history" : "Close" }}</button>',
        '<button>@if (flag) {Delete all conversation history} @else {Close}</button>',
        '<button>Delete {{ flag ? "all" : "some" }} conversation history</button>',
        '<button>Delete @if (flag) {all} @else {some} conversation history</button>',
        '<button>{{ flag && "Delete all conversation history" }}</button>',
      ];
      for (const html of good) { tree.write(html); expect(checkLedger(analyze(tree.root, {}), ledger), html).toEqual([]); }
    } finally { tree.cleanup(); }
  });
  it.each(['class="sr-only"', 'class="visually-hidden"', 'hidden', 'style="display: none"', 'style="visibility: hidden"', '[hidden]="true"', '[attr.hidden]="false"', '[class.sr-only]="true"', '[style.display]="\'none\'"', '[class]="\'sr-only\'"', '[attr.class]="\'visually-hidden\'"', '[style]="\'display: none\'"', '[attr.style]="\'visibility: hidden\'"'])('does not accept hidden warning text as visible: %s', attribute => {
    const tree = fixtureTree('<button title="Delete all conversation history">Delete</button>');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []);
      tree.write(`<button><span ${attribute}>Delete all conversation history</span>×</button>`);
      expect(checkLedger(analyze(tree.root, {}), ledger)).not.toEqual([]);
    } finally { tree.cleanup(); }
  });
  it('still accepts text on a statically visible bound element', () => {
    const tree = fixtureTree('<button title="Delete all conversation history">Delete</button>');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []);
      tree.write('<button><span [hidden]="false" [class.sr-only]="false">Delete all conversation history</span></button>');
      expect(checkLedger(analyze(tree.root, {}), ledger)).toEqual([]);
    } finally { tree.cleanup(); }
  });
  it('bounds alternative expansion while keeping every fallback fragment separated', () => {
    const tree = fixtureTree('<button title="Delete all conversation history">Delete</button>');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []);
      const choices = Array.from({ length: 8 }, (_, index) => `flag${index} ? "x" : "y"`).map(value => `(${value})`).join(' + ');
      tree.write(`<button>Delete all {{ ${choices} }} conversation history</button>`);
      expect(checkLedger(analyze(tree.root, {}), ledger)).not.toEqual([]);
    } finally { tree.cleanup(); }
  });
  it('rejects shortened hover, aria-only and reordered words; accepts visible text, longer text and copy registry', () => {
    const tree = fixtureTree('<button title="Delete all conversation history">Delete</button>');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []); expect(ledger).toHaveLength(1);
      for (const html of ['<button appTooltip="Delete history">Delete</button>', '<button aria-label="Delete all conversation history">×</button>', '<button appTooltip="Delete conversation all history">Delete</button>']) {
        tree.write(html); expect(checkLedger(analyze(tree.root, {}), ledger).join(' ')).toMatch(/H9 hover wording lost/);
      }
      for (const html of ['<button>Delete all conversation history</button>', '<button appTooltip="Now delete all conversation history permanently">Delete</button>']) {
        tree.write(html); expect(checkLedger(analyze(tree.root, {}), ledger)).toEqual([]);
      }
      tree.file('src/renderer/app/tooltip-copy.ts', 'export const TOOLTIP_COPY = { "history.delete": { meaning: "Delete all conversation history" }};');
      tree.write('<button [appTooltip]="copy(\'history.delete\')">Delete</button>');
      expect(checkLedger(analyze(tree.root, {}), ledger)).toEqual([]);
    } finally { tree.cleanup(); }
  });
  it('protects same-class closeTooltip sentences and detects moving to an external helper', () => {
    const tree = fixtureTree('<button [appTooltip]="closeTooltip()">×</button>', 'closeTooltip() { return "Close session stops this child agent and removes it from the tree"; }');
    try {
      const original = analyze(tree.root, {}); const ledger = recordNew(original, []);
      expect(ledger.some(entry => entry.text.includes('stops'))).toBe(true);
      tree.write('<button [appIconButton]="\'Close session\'">×</button>');
      expect(checkLedger(analyze(tree.root, {}), ledger).join(' ')).toMatch(/stops.*removes/);
      tree.file(tree.owner, '@Component({imports: [AioTooltipDirective], template: `<button [appTooltip]="externalHint()">×</button>`}) class X {}');
      tree.file('src/renderer/other/hint.ts', 'export function externalHint() { return "Close session stops this child agent and removes it from the tree"; }');
      const moved = analyze(tree.root, {});
      expect(checkLedger(moved, ledger)).not.toEqual([]); expect(moved.counts['unreadable']).toBeGreaterThan(original.counts['unreadable']!);
    } finally { tree.cleanup(); }
  });
  it('records an icon-button disabled-reason alias without treating it as a standalone host', () => {
    const tree = fixtureTree('<button appIconButton="Send" appIconButtonDisabledReason="Cannot send before choosing a working folder">×</button>');
    try {
      const analysis = analyze(tree.root, {}); const ledger = recordNew(analysis, []);
      expect(analysis.facts[0]?.hover.some(hover => hover.channel === 'appIconButtonDisabledReason')).toBe(true);
      expect(ledger.some(entry => entry.text.includes('Cannot send'))).toBe(true);
      tree.write('<button appIconButton="Send">×</button>');
      expect(checkLedger(analyze(tree.root, {}), ledger).join(' ')).toContain('cannot');
    } finally { tree.cleanup(); }
  });
  it('dynamic template holes do not fabricate a contiguous old sentence', () => {
    const tree = fixtureTree('<button [appTooltip]="hover()">Delete</button>', 'hover() { return "Delete all conversation history"; }');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []);
      tree.file(tree.owner, '@Component({imports: [AioTooltipDirective], template: `<button [appTooltip]="hover()">Delete</button>`}) class X { hover() { return `Delete ${target}all conversation history`; } }');
      expect(checkLedger(analyze(tree.root, {}), ledger).join(' ')).toContain('H9 hover wording lost');
    } finally { tree.cleanup(); }
  });
  it('strips shortcuts without losing ordinary warning words', () => {
    for (const [old, next] of [['Close panel (⌥⌘S). Running sidechats keep going.', 'Close panel. Running sidechats keep going.'], ['Stop current turn (Esc)', 'Stop current turn'], ['Stop current turn (Enter)', 'Stop current turn'], ['Stop current turn Ctrl+Shift+K', 'Stop current turn']]) expect(tokens(old!)).toEqual(tokens(next!));
    expect(tokens('Discard changes (revert to HEAD)')).toEqual(tokens('discard changes - revert to head'));
    const tree = fixtureTree('<button appTooltip="Close panel (⌥⌘S). Running sidechats keep going.">Close</button>');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []);
      tree.write('<button appTooltip="Close panel. sidechats keep going.">Close</button>');
      expect(checkLedger(analyze(tree.root, {}), ledger).join(' ')).toContain('running');
    } finally { tree.cleanup(); }
  });
  it.each([['Delete all conversation history', 'consequence'], ['Cancel delete', null], ['Open file', null], ['Clear all notifications', 'consequence'], ['Will send before passive queued messages', 'consequence'], ['Some long sentence with more than seven ordinary words', 'long']])('classifies %s', (text, expected) => { expect(classify(text!)).toBe(expected); });
  it('recordNew only adds and retirement requires unique meaningful reasons with an immutable audit trail', () => {
    const tree = fixtureTree('<button title="Delete all conversation history">Delete</button>');
    try {
      const analysis = analyze(tree.root, {}); const ledger = recordNew(analysis, []); const id = ledger[0]!.id;
      expect(recordNew(analysis, ledger)).toEqual(ledger);
      expect(() => retire(ledger, id, 'short')).toThrow(/20/);
      const retired = retire(ledger, id, 'The control was removed with its entire owning feature.');
      expect(checkLedger(analysis, retired)).toEqual([]);
      expect(compareLedgers(ledger, retired).retirements).toHaveLength(1);
      expect(compareLedgers(ledger, []).errors).toHaveLength(1);
      expect(compareLedgers(ledger, [{ ...ledger[0]!, text: 'Delete history' }]).errors.join(' ')).toContain('edited');
      expect(compareLedgers(retired, ledger).errors.join(' ')).toContain('audit trail');
      expect(() => retire([...retired, { ...ledger[0]!, id: 'second' }], 'second', retired[0]!.retired!)).toThrow(/unique/);
    } finally { tree.cleanup(); }
  });
  it('classifies every tooltip directive selector, so a new text provider needs an explicit decision', () => {
    const directory = join(process.cwd(), 'src/renderer/app/shared/tooltip');
    const neither = ['appTooltipVariant', 'appTooltipPosition', 'appTooltipDisabled', 'appTooltipFormat', 'appTooltipShortcut', 'appTooltipShortcutLabel', 'appTooltipDelay'];
    const files = readdirSync(directory).filter(file => /\.directive\.ts$/.test(file));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(directory, file), 'utf8');
      const selectors = [...source.matchAll(/selector:\s*['"]([^'"]+)['"]/g)].flatMap(match => [...match[1]!.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]!));
      expect(selectors.length).toBeGreaterThan(0);
      for (const selector of selectors) expect([...HOVER_BINDINGS, ...TOOLTIP_PROVIDERS, ...NAME_PROVIDERS, ...neither]).toContain(selector);
    }
  });
});
