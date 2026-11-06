import { describe, expect, it } from 'vitest';
import { analyze } from '../ui-hints/analyze';
import { checkLedger, recordNew } from '../ui-hints/wording-ledger.js';
import { fixtureTree } from './ui-hints-fixtures';

describe('statically readable hover text after integration', () => {
  it('recognizes Angular input data without executing it or discarding a literal default', () => {
    const tree = fixtureTree('');
    try {
      tree.file(tree.owner, 'import { input as field } from "@angular/core";\n@Component({ imports: [AioTooltipDirective], template: `<button [appTooltipDisabledReason]="item().reason ?? fallback()">Send</button>` }) class Sample { item = field.required<{reason?: string}>(); fallback = field("Choose a working folder before sending"); }');
      const analysis = analyze(tree.root, {});
      expect(analysis.counts['unreadable']).toBe(0);
      expect(recordNew(analysis, []).map(entry => entry.text)).toContain('Choose a working folder before sending');
    } finally { tree.cleanup(); }
  });

  it('keeps unsupported helper declarations and service calls unreadable', () => {
    const tree = fixtureTree('<button appTooltip="Delete all conversation history">Delete</button>');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []);
      tree.file(tree.owner, '@Component({ imports: [AioTooltipDirective], template: `<button [appTooltip]="hint()">Delete</button>` }) class Sample { hint() { return disclosure(); } } function disclosure() { return "Delete all conversation history"; }');
      const original = analyze(tree.root, {});
      expect(original.counts['unreadable']).toBe(1);
      expect(recordNew(original, []).map(entry => entry.text)).not.toContain('Delete all conversation history');
      expect(checkLedger(original, ledger).join(' ')).toContain('H9 hover wording lost');
      tree.file(tree.owner, '@Component({ imports: [AioTooltipDirective], template: `<button [appTooltip]="hint()">Delete</button>` }) class Sample { hint() { return service.disclosure(); } }');
      expect(analyze(tree.root, {}).counts['unreadable']).toBe(1);
      expect(checkLedger(analyze(tree.root, {}), ledger).join(' ')).toContain('H9 hover wording lost');
    } finally { tree.cleanup(); }
  });
  it.each([
    'field("Delete all conversation history", { transform: shorten })',
    'field.required({ transform: shorten })',
    'field("Delete all conversation history", externalOptions)',
    'field("Delete all conversation history", { __proto__: { transform: shorten } })',
    'field("Delete all conversation history", { "__proto__": { transform: shorten } })',
  ])('does not certify an input whose options can transform its text: %s', initializer => {
    const tree = fixtureTree('');
    try {
      tree.file(tree.owner, `import { input as field } from "@angular/core";\n@Component({ imports: [AioTooltipDirective], template: '<button [appTooltip]="hint()">Delete</button>' }) class Sample { hint = ${initializer}; }`);
      const analysis = analyze(tree.root, {});
      expect(analysis.counts['unreadable']).toBe(1);
      expect(recordNew(analysis, []).map(entry => entry.text)).not.toContain('Delete all conversation history');
    } finally { tree.cleanup(); }
  });
  it.each([
    'hint(field: () => string) { return field(); }',
    'hint(field: { required: () => string }) { return field.required(); }',
    'hint() { const field = () => "Delete history"; return field(); }',
    'hint() { const field = { required: () => "Delete history" }; return field.required(); }',
  ])('does not certify a shadowed Angular input binding: %s', method => {
    const tree = fixtureTree('');
    try {
      tree.file(tree.owner, `import { input as field } from "@angular/core";\n@Component({ imports: [AioTooltipDirective], template: '<button [appTooltip]="hint()">Delete</button>' }) class Sample { ${method} }`);
      expect(analyze(tree.root, {}).counts['unreadable']).toBe(1);
    } finally { tree.cleanup(); }
  });
  it.each([
    ['disclosure("Delete history")', 'function disclosure(text = "Delete all conversation history") { return text; }'],
    ['disclosure()', 'function disclosure() { const unused = "Delete all conversation history"; return "Delete history"; }'],
    ['disclosure("Delete all conversation history")', 'function disclosure(unused: string) { return "Delete history"; }'],
    ['disclosure()', 'function disclosure() { try { return "Delete all conversation history"; } finally { return "Delete history"; } }'],
    ['disclosure()', 'function disclosure() { return "Delete history"; return "Delete all conversation history"; }'],
  ])('does not use unused helper words to preserve a warning: %s', (call, helper) => {
    const tree = fixtureTree('<button appTooltip="Delete all conversation history">Delete</button>');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []);
      tree.file(tree.owner, `@Component({ imports: [AioTooltipDirective], template: '<button [appTooltip]="hint()">Delete</button>' }) class Sample { hint() { return ${call}; } } ${helper}`);
      const analysis = analyze(tree.root, {});
      expect(checkLedger(analysis, ledger).join(' ')).toContain('H9 hover wording lost');
      expect(recordNew(analysis, []).map(entry => entry.text)).not.toContain('Delete all conversation history');
    } finally { tree.cleanup(); }
  });
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

  it.each(['words.used', 'hint()'])('reads only the selected immutable copy entry through %s', expression => {
    const tree = fixtureTree('');
    try {
      tree.file('src/shared/copy.ts', 'throw new Error("must never execute"); export const OTHER = "unrelated"; export const WORDS = { used: "Delete all conversation history", other: "Discard every saved change forever" } as const;');
      tree.file(tree.owner, `import { WORDS } from "../../shared/copy";\n@Component({ imports: [AioTooltipDirective], template: '<button [appTooltip]="${expression}">Delete</button>' }) class Sample { words = WORDS; hint() { return WORDS.used; } }`);
      const original = analyze(tree.root, {});
      expect(original.counts['unreadable']).toBe(0);
      const ledger = recordNew(original, []);
      expect(ledger.map(entry => entry.text)).toEqual(['Delete all conversation history']);
      tree.file('src/shared/copy.ts', 'export const WORDS = { used: "Delete history", other: "Delete all conversation history" } as const;');
      expect(checkLedger(analyze(tree.root, {}), ledger).join(' ')).toContain('H9 hover wording lost');
    } finally { tree.cleanup(); }
  });

  it('does not substitute an import for a shadowing component member', () => {
    const tree = fixtureTree('<button appTooltip="Delete all conversation history">Delete</button>');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []);
      tree.file('src/shared/copy.ts', 'export const WORDS = { used: "Delete all conversation history" } as const;');
      tree.file(tree.owner, 'import { WORDS } from "../../shared/copy";\n@Component({ imports: [AioTooltipDirective], template: `<button [appTooltip]="WORDS.used">Delete</button>` }) class Sample { WORDS = { used: "Delete history" }; }');
      const analysis = analyze(tree.root, {});
      expect(checkLedger(analysis, ledger).join(' ')).toContain('H9 hover wording lost');
      expect(analysis.facts.flatMap(fact => fact.hover.flatMap(hover => hover.fragments))).toEqual(['Delete history']);
    } finally { tree.cleanup(); }
  });
  it.each([
    'hint() { const WORDS = { used: "Delete history" }; return WORDS.used; }',
    'hint(WORDS: { used: string }) { return WORDS.used; }',
  ])('does not substitute an import for a method-local binding: %s', method => {
    const tree = fixtureTree('<button appTooltip="Delete all conversation history">Delete</button>');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []);
      tree.file('src/shared/copy.ts', 'export const WORDS = { used: "Delete all conversation history" } as const;');
      tree.file(tree.owner, `import { WORDS } from "../../shared/copy";\n@Component({ imports: [AioTooltipDirective], template: '<button [appTooltip]="hint()">Delete</button>' }) class Sample { ${method} }`);
      const analysis = analyze(tree.root, {});
      expect(analysis.counts['unreadable']).toBe(1);
      expect(checkLedger(analysis, ledger).join(' ')).toContain('H9 hover wording lost');
      expect(recordNew(analysis, []).map(entry => entry.text)).not.toContain('Delete all conversation history');
    } finally { tree.cleanup(); }
  });

  it.each([
    '{ used: "Delete all conversation history" }',
    '{ other: "Delete all conversation history" } as const',
    '{ used: "Delete all conversation history", ...externalWords } as const',
    '{ used: "Delete all conversation history", used: "Delete history" } as const',
    '{ used: "Delete all conversation history", [externalKey]: "Delete history" } as const',
    '{ used: "Delete all conversation history", __proto__: {} } as const',
  ])('does not certify an unresolved or mutable record projection: %s', record => {
    const tree = fixtureTree('');
    try {
      tree.file('src/shared/copy.ts', `export const WORDS = ${record};`);
      tree.file(tree.owner, 'import { WORDS } from "../../shared/copy";\n@Component({ imports: [AioTooltipDirective], template: `<button [appTooltip]="words.used">Delete</button>` }) class Sample { words = WORDS; }');
      expect(analyze(tree.root, {}).counts['unreadable']).toBe(1);
    } finally { tree.cleanup(); }
  });

  it.each(['__proto__', '"__proto__"'])('does not mistake a prototype setter for an own literal property: %s', key => {
    const tree = fixtureTree('<button appTooltip="Delete all conversation history">Delete</button>');
    try {
      const ledger = recordNew(analyze(tree.root, {}), []);
      tree.file('src/shared/copy.ts', `export const WORDS = { ${key}: "Delete all conversation history" } as const;`);
      tree.file(tree.owner, 'import { WORDS } from "../../shared/copy";\n@Component({ imports: [AioTooltipDirective], template: `<button [appTooltip]="words.__proto__">Delete</button>` }) class Sample { words = WORDS; }');
      const analysis = analyze(tree.root, {});
      expect(analysis.counts['unreadable']).toBe(1);
      expect(checkLedger(analysis, ledger).join(' ')).toContain('H9 hover wording lost');
      expect(recordNew(analysis, []).map(entry => entry.text)).not.toContain('Delete all conversation history');
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
