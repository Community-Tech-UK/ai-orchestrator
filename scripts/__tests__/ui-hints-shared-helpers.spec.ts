import { describe, expect, it } from 'vitest';
import { analyze } from '../ui-hints/analyze';
import { checkLedger, recordNew } from '../ui-hints/wording-ledger.js';
import { fixtureTree } from './ui-hints-fixtures';

const READABLE = '/** @hoverTextReadable */\n';
const NAMES = [
  'export const NAMES = { a: { short: "Claude" }, b: { short: "Codex" } };',
  'const UNKNOWN = "AI provider";',
  `${READABLE}export function nameOf(id: string): string { return NAMES[id]?.short ?? UNKNOWN; }`,
].join('\n');
const component = (call: string, imports = 'import { nameOf } from "../../shared/names";') =>
  `${imports}\n@Component({ imports: [AioTooltipDirective], template: '<button [appTooltip]="hint()">Stop</button>' }) class Sample { hint() { return ${call}; } }`;
const fragments = (root: string): string[] => analyze(root, {}).facts.flatMap(fact => fact.hover.flatMap(hover => hover.fragments));

describe('hover text that comes from a shared helper', () => {
  it('reads every word a shared name helper can show instead of calling the hover unreadable', () => {
    const tree = fixtureTree('');
    try {
      tree.file('src/shared/names.ts', NAMES);
      tree.file(tree.owner, component('`Interrupt ${nameOf("a")}`'));
      const analysis = analyze(tree.root, {});
      expect(analysis.counts['unreadable']).toBe(0);
      expect(fragments(tree.root)).toEqual(expect.arrayContaining(['Interrupt ', 'Claude', 'Codex', 'AI provider']));
    } finally { tree.cleanup(); }
  });

  it('protects those words: losing one from the helper is reported', () => {
    const tree = fixtureTree('');
    try {
      tree.file('src/shared/names.ts', `${READABLE}export function stopNote(): string { return "Stopping discards the unsaved answer"; }`);
      tree.file(tree.owner, component('stopNote()', 'import { stopNote } from "../../shared/names";'));
      const ledger = recordNew(analyze(tree.root, {}), []);
      expect(ledger.map(entry => entry.text)).toContain('Stopping discards the unsaved answer');
      tree.file('src/shared/names.ts', `${READABLE}export function stopNote(): string { return "Stopping"; }`);
      expect(checkLedger(analyze(tree.root, {}), ledger).join(' ')).toContain('H9 hover wording lost');
    } finally { tree.cleanup(); }
  });

  it('follows a helper into the other shared modules it calls', () => {
    const tree = fixtureTree('');
    try {
      tree.file('src/shared/labels.ts', 'export const LABELS = { idle: "Ready", busy: "Working" } as const;\nexport function label(status: string): string { return LABELS[status as keyof typeof LABELS]; }');
      tree.file('src/shared/names.ts', `import { label } from "./labels";\n${READABLE}export function describe(status: string): string { return \`\${label(status)} - waiting for you\`; }`);
      tree.file(tree.owner, component('describe("idle")', 'import { describe } from "../../shared/names";'));
      expect(analyze(tree.root, {}).counts['unreadable']).toBe(0);
      expect(fragments(tree.root)).toEqual(expect.arrayContaining(['Ready', 'Working', ' - waiting for you']));
    } finally { tree.cleanup(); }
  });

  it('does not count words a helper only compares, throws or uses as table keys', () => {
    const tree = fixtureTree('');
    try {
      tree.file('src/shared/names.ts', [
        'const TABLE = { "internal-key": "Claude" };',
        `${READABLE}export function nameOf(id: string): string {`,
        '  if (id === "never-shown") throw new Error("Delete everything");',
        '  return id.startsWith("prefix-") ? TABLE["internal-key"] : "AI provider";',
        '}',
      ].join('\n'));
      tree.file(tree.owner, component('nameOf("a")'));
      const found = fragments(tree.root);
      expect(found).toEqual(expect.arrayContaining(['Claude', 'AI provider']));
      for (const notShown of ['never-shown', 'Delete everything', 'internal-key', 'prefix-']) expect(found).not.toContain(notShown);
    } finally { tree.cleanup(); }
  });

  it.each([
    ['a helper that reaches a package', 'src/shared/names.ts', `import { lookup } from "some-package";\n${READABLE}export function nameOf(id: string): string { return lookup(id) ?? "AI provider"; }`, '../../shared/names'],
    ['a helper outside the shared folder', 'src/other/names.ts', `${READABLE}export function nameOf(id: string): string { return id ? "Claude" : "AI provider"; }`, '../../other/names'],
    ['a helper that is not a function or table', 'src/shared/names.ts', `${READABLE}export const nameOf = service.names();`, '../../shared/names'],
    ['a helper that does not say its words can be read', 'src/shared/names.ts', 'export function nameOf(id: string): string { return id ? "Claude" : "AI provider"; }', '../../shared/names'],
  ])('keeps %s unreadable', (_label, file, text, specifier) => {
    const tree = fixtureTree('');
    try {
      tree.file(file, text);
      tree.file(tree.owner, component('nameOf("a")', `import { nameOf } from "${specifier}";`));
      expect(analyze(tree.root, {}).counts['unreadable']).toBe(1);
    } finally { tree.cleanup(); }
  });
});
