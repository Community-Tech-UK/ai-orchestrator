import { describe, expect, it } from 'vitest';
import { analyze } from '../ui-hints/analyze';
import { checkLedger, recordNew } from '../ui-hints/wording-ledger.js';
import { fixtureTree } from './ui-hints-fixtures';

describe('statically readable hover text after integration', () => {
  it('protects an aliased exported literal constant from shared copy without executing its module', () => {
    const tree = fixtureTree('');
    try {
      tree.file('src/shared/copy.ts', 'throw new Error("must never execute"); export const WARNING = "Delete all conversation history";');
      tree.file(tree.owner, 'import { WARNING as sharedWarning } from "../../shared/copy";\n@Component({ imports: [AioTooltipDirective], template: `<button [appTooltip]="hint">Delete</button>` }) class Sample { hint = sharedWarning; }');
      const original = analyze(tree.root, {});
      expect(original.counts['unreadable']).toBe(0);
      const ledger = recordNew(original, []);
      expect(ledger.map(entry => entry.text)).toContain('Delete all conversation history');
      tree.file('src/shared/copy.ts', 'export const WARNING = "Delete history";');
      expect(checkLedger(analyze(tree.root, {}), ledger).join(' ')).toContain('H9 hover wording lost');
    } finally { tree.cleanup(); }
  });

  it.each([
    ['let', '"Delete all conversation history"', 'src/shared/copy.ts', '../../shared/copy'],
    ['const', 'service.warning()', 'src/shared/copy.ts', '../../shared/copy'],
    ['const', '"Delete all conversation history"', 'outside.ts', '../../../outside'],
  ])('keeps %s %s from %s unreadable', (kind, value, file, imported) => {
    const tree = fixtureTree('');
    try {
      tree.file(file, `export ${kind} WARNING = ${value};`);
      tree.file(tree.owner, `import { WARNING } from "${imported}";\n@Component({ imports: [AioTooltipDirective], template: '<button [appTooltip]="hint">Delete</button>' }) class Sample { hint = WARNING; }`);
      expect(analyze(tree.root, {}).counts['unreadable']).toBe(1);
    } finally { tree.cleanup(); }
  });

  it('records exact platform replacements instead of the unreplaced registry wording', () => {
    const tree = fixtureTree('<button [appTooltip]="hint">Awake</button>', 'hint = copyFor("awake").replaceAll("your Mac", "your computer").replaceAll("the Mac", "the computer");');
    try {
      tree.file('src/renderer/app/tooltip-copy.ts', 'export const TOOLTIP_COPY = { awake: { meaning: "Keep your Mac awake until the Mac is closed" } };');
      const analysis = analyze(tree.root, {});
      expect(analysis.counts['unreadable']).toBe(0);
      expect(recordNew(analysis, []).map(entry => entry.text)).toEqual(['Keep your computer awake until the computer is closed']);
    } finally { tree.cleanup(); }
  });

  it('detects a warning removed by a static replacement', () => {
    const tree = fixtureTree('<button [appTooltip]="hint">Delete</button>', 'hint = copyFor("delete");');
    try {
      tree.file('src/renderer/app/tooltip-copy.ts', 'export const TOOLTIP_COPY = { delete: { meaning: "Delete all conversation history" } };');
      const ledger = recordNew(analyze(tree.root, {}), []);
      tree.file(tree.owner, '@Component({ imports: [AioTooltipDirective], template: `<button [appTooltip]="hint">Delete</button>` }) class Sample { hint = copyFor("delete").replaceAll("all conversation ", ""); }');
      expect(checkLedger(analyze(tree.root, {}), ledger).join(' ')).toContain('H9 hover wording lost');
    } finally { tree.cleanup(); }
  });

  it.each(['service.warning().replaceAll("Mac", "computer")', 'copyFor("awake").replaceAll(search(), "computer")'])('keeps dynamic transformations unreadable: %s', expression => {
    const tree = fixtureTree('<button [appTooltip]="hint">Awake</button>', `hint = ${expression};`);
    try {
      tree.file('src/renderer/app/tooltip-copy.ts', 'export const TOOLTIP_COPY = { awake: { meaning: "Keep your Mac awake until the Mac is closed" } };');
      expect(analyze(tree.root, {}).counts['unreadable']).toBe(1);
    } finally { tree.cleanup(); }
  });
});
