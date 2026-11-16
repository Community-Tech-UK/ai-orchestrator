import { describe, expect, it } from 'vitest';
import { extractHtmlStrings, extractTsStrings, isModelFacing, isScannedPath } from './extract-ui-text';
import { appNameHits, instanceThreadHits, statusWordHits } from './ui-text-rules';

const ts = (source: string, file = 'src/renderer/app/x.ts') => extractTsStrings(file, source);
const texts = (strings: { text: string }[]) => strings.map((s) => s.text);

describe('extractTsStrings', () => {
  it('leaves comments out', () => {
    expect(ts('// restart AIO now\n/* AIO and instance */\nconst a = 1;')).toEqual([]);
  });

  it('leaves logger, console and getLogger arguments out', () => {
    const source = "const logger = getLogger('AIO Service');\nlogger.info('restart AIO now');\nconsole.warn('the instance failed');\nthis.logger.error('instance gone');";
    expect(ts(source)).toEqual([]);
  });

  it('leaves module paths, property names and type literals out, but keeps their values', () => {
    const source = "import x from './orchestrator AIO thing';\ntype T = 'AIO is a type';\nconst o = { 'a key': 'Restart AIO.' };";
    expect(texts(ts(source))).toEqual(['Restart AIO.']);
  });

  it('reads every part of a template string', () => {
    expect(texts(ts('const m = `AIO needs ${n} sessions and orchestrator ${x} help`;'))).toEqual(['AIO needs ', ' sessions and orchestrator ', ' help']);
  });

  it('reads an inline template as HTML and leaves styles alone', () => {
    const source = "@Component({ template: `<p>Restart AIO.</p>`, styles: [`.a { content: 'AIO'; }`] })\nclass C {}";
    const found = ts(source);
    expect(texts(found)).toEqual(['Restart AIO.']);
    expect(found[0].kind).toBe('html');
  });

  it('leaves SQL statements out', () => {
    expect(ts("db.exec(`CREATE TABLE orchestrator_x (id TEXT,\n scope TEXT DEFAULT 'orchestrator')`);")).toEqual([]);
  });
});

describe('extractHtmlStrings', () => {
  const html = (source: string) => texts(extractHtmlStrings('x.html', source));

  it('reads text nodes and the named attributes, and skips comments, control flow and expressions', () => {
    const found = html('<!-- AIO comment -->\n@if (a === \'AIO\') {\n<button title="Stop AIO" aria-label="Stop it" data-x="AIO">Stop {{ name }}</button>\n}');
    expect(found).toEqual(['Stop AIO', 'Stop it', 'Stop']);
  });

  it('reads quoted literals inside interpolations and property bindings only', () => {
    const found = html('<span>{{ ok ? \'Ready now\' : \'Not ready\' }}</span><app-x [label]="\'Open AIO\'" [class.big]="\'zzz\'"></app-x>');
    expect(found).toEqual(expect.arrayContaining(['Ready now', 'Not ready', 'Open AIO']));
    expect(found).not.toContain('zzz');
  });

  it('keeps line numbers', () => {
    expect(extractHtmlStrings('x.html', '<p>one</p>\n\n<p>two</p>').map((s) => s.line)).toEqual([1, 3]);
  });
});

describe('the rules', () => {
  const hit = (text: string, file = 'src/main/x.ts') => appNameHits([{ file, line: 1, text, kind: 'ts' }]);

  it('counts "restart AIO." as an app name and ignores data that merely contains the word', () => {
    expect(hit('Please restart AIO.')).toHaveLength(1);
    expect(hit('AIO-Agent folder')).toHaveLength(0);
    expect(hit('Saved in ~/.orchestrator/permissions.json today')).toHaveLength(0);
    expect(hit('Run aio-mcp settings now')).toHaveLength(0);
  });

  it('counts a one-word capitalised label but not a one-word provider id', () => {
    expect(hit('Orchestrator')).toHaveLength(1);
    expect(hit('orchestrator')).toHaveLength(0);
    expect(hit('while orchestrator is paused')).toHaveLength(1);
  });

  it('counts instance and thread only in renderer and shared copy, and only in sentences', () => {
    const count = (file: string, text: string) => instanceThreadHits([{ file, line: 1, text, kind: 'ts' }]).length;
    expect(count('src/renderer/app/a.ts', 'Failed to create instance')).toBe(1);
    expect(count('src/shared/a.ts', 'Untitled thread')).toBe(1);
    expect(count('src/main/a.ts', 'Failed to create instance')).toBe(0);
    expect(count('src/renderer/app/a.ts', 'instance')).toBe(0);
  });

  it('finds the old status phrases', () => {
    const count = (text: string) => statusWordHits([{ file: 'a.ts', line: 1, text, kind: 'ts' }]).length;
    expect(count('Waiting for input')).toBe(1);
    expect(count('Hibernated')).toBe(1);
    expect(count('hibernated')).toBe(0);
    expect(count('This session may be waiting for input from a program.')).toBe(0);
  });
});

describe('which files are read', () => {
  it('skips specs, fixtures, generated code and model-facing files', () => {
    expect(isScannedPath('src/renderer/app/a.component.ts')).toBe(true);
    expect(isScannedPath('src/renderer/app/a.component.html')).toBe(true);
    expect(isScannedPath('src/renderer/app/a.spec.ts')).toBe(false);
    expect(isScannedPath('src/main/__tests__/a.ts')).toBe(false);
    expect(isScannedPath('src/preload/generated/channels.ts')).toBe(false);
    expect(isModelFacing('src/main/agents/review-agents/a.ts')).toBe(true);
    expect(isModelFacing('src/main/x/summary.prompts.ts')).toBe(true);
    expect(isModelFacing('src/renderer/app/a.component.ts')).toBe(false);
  });
});
