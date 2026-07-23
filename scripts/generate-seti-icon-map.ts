/**
 * generate-seti-icon-map.ts
 *
 * Regenerates `src/renderer/app/shared/file-icons/file-icon-map.generated.ts`
 * from the vendored VS Code Seti icon theme
 * (`src/renderer/assets/icons/seti/vs-seti-icon-theme.json`).
 *
 * Why this exists
 * ---------------
 * The Source Control view renders VS Code's default (Seti) file-type icons.
 * VS Code ships the glyph artwork as a woff font plus a JSON theme that maps
 * filenames / extensions / language-ids → `{ fontCharacter, fontColor }`. We
 * vendor the font + JSON (both MIT — see the LICENSE.md beside them) and
 * precompile the JSON into a plain TS lookup so the renderer needs no runtime
 * JSON fetch or parsing.
 *
 * The catch: the common code extensions (`ts`, `js`, `md`, `html`, `scss`,
 * `json`, `py`, `java`, `yml`, …) are NOT in the theme's `fileExtensions`
 * map — in VS Code they resolve through the file's detected *language id*
 * (e.g. `.ts` → `typescript` → `_typescript`). Since the renderer has no
 * language-detection service, this generator bridges the gap with a curated
 * extension → language-id table (`EXTENSION_LANGUAGE_BRIDGE`) covering the
 * language ids the theme actually defines. Direct `fileExtensions` entries
 * always win over bridge-derived ones (matching VS Code's precedence:
 * filename → longest file-extension → language id).
 *
 * Output shape (see `file-icon.ts` for the consumer):
 *   SETI_EXTENSION_ICONS: Record<string, FileIconDef>   // keys lowercase, compound included
 *   SETI_FILENAME_ICONS:  Record<string, FileIconDef>   // keys lowercase
 *   SETI_DEFAULT_ICON:    FileIconDef
 *   FileIconDef = { glyph: string; color: string }
 *
 * Usage:
 *   npm run generate:file-icons               # rewrite the generated file
 *   tsx scripts/generate-seti-icon-map.ts --check   # CI: fail if drifted
 *
 * The generated file is committed and MUST NOT be hand-edited — re-run this
 * script instead.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const THEME_FILE = resolve(
  SCRIPT_DIR,
  '../src/renderer/assets/icons/seti/vs-seti-icon-theme.json',
);
const OUTPUT_FILE = resolve(
  SCRIPT_DIR,
  '../src/renderer/app/shared/file-icons/file-icon-map.generated.ts',
);

interface IconDefinition {
  fontCharacter: string;
  fontColor?: string;
}

interface SetiTheme {
  iconDefinitions: Record<string, IconDefinition>;
  file: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  languageIds: Record<string, string>;
}

interface FileIconDef {
  glyph: string;
  color: string;
}

/**
 * Curated extension → language-id bridge. Only language ids the Seti theme
 * actually defines are useful here (others are dropped during resolution).
 * Extensions listed directly in the theme's `fileExtensions` override these.
 */
const EXTENSION_LANGUAGE_BRIDGE: Record<string, string> = {
  // TypeScript / JavaScript
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascriptreact',
  // Data / config
  json: 'json', jsonc: 'jsonc', jsonl: 'jsonl',
  yml: 'yaml', yaml: 'yaml',
  xml: 'xml', xsl: 'xml', xsd: 'xml', xslt: 'xml',
  properties: 'properties', ini: 'properties', cfg: 'properties',
  env: 'dotenv',
  // Markup / docs
  md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html',
  tex: 'tex', latex: 'latex',
  // Stylesheets
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  pcss: 'postcss', postcss: 'postcss', styl: 'stylus',
  // Templating
  hbs: 'handlebars', handlebars: 'handlebars', mustache: 'mustache',
  haml: 'haml', jade: 'jade', pug: 'jade', njk: 'nunjucks',
  // Systems / compiled
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp',
  go: 'go', rs: 'rust', swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  java: 'java', gradle: 'gradle', groovy: 'groovy',
  m: 'objective-c', mm: 'objective-cpp',
  dart: 'dart', hx: 'haxe', vala: 'vala',
  // Scripting
  py: 'python', pyw: 'python', pyi: 'python',
  rb: 'ruby', php: 'php',
  pl: 'perl', pm: 'perl',
  lua: 'lua', r: 'r', jl: 'julia',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'shellscript',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'bat', cmd: 'bat',
  // Functional
  ex: 'elixir', exs: 'elixir',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  coffee: 'coffeescript',
  hs: 'haskell', elm: 'elm',
  ml: 'ocaml', mli: 'ocaml',
  fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp',
  res: 'rescript',
  // Data / infra
  sql: 'sql',
  tf: 'terraform', tfvars: 'terraform',
  bicep: 'bicep',
  // Misc
  gitignore: 'ignore',
};

/**
 * Curated filename → language-id bridge for well-known files whose VS Code
 * icon comes from a *language* association rather than the theme's `fileNames`
 * map (e.g. `Dockerfile` → dockerfile, `Makefile` → makefile). Theme
 * `fileNames` entries override these. Keys are matched case-insensitively.
 */
const FILENAME_LANGUAGE_BRIDGE: Record<string, string> = {
  dockerfile: 'dockerfile',
  '.dockerignore': 'ignore',
  makefile: 'makefile',
  'gnumakefile': 'makefile',
  '.gitignore': 'ignore',
  '.gitattributes': 'ignore',
  '.npmignore': 'ignore',
  '.eslintignore': 'ignore',
  '.env': 'dotenv',
  '.env.local': 'dotenv',
};

function parseGlyph(fontCharacter: string): string {
  // Theme stores glyphs as escaped Private-Use-Area code points, e.g. "\E099".
  const hex = fontCharacter.replace(/[^0-9a-fA-F]/g, '');
  return String.fromCodePoint(parseInt(hex, 16));
}

/** Emit a glyph as a `\uXXXX` escape so the generated file stays ASCII. */
function glyphEscape(glyph: string): string {
  const code = glyph.codePointAt(0) ?? 0;
  return `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

function buildMaps(theme: SetiTheme): {
  extensionIcons: Record<string, FileIconDef>;
  filenameIcons: Record<string, FileIconDef>;
  defaultIcon: FileIconDef;
} {
  const defs = theme.iconDefinitions;
  const defaultDef = defs[theme.file];
  const defaultColor = defaultDef?.fontColor ?? '#d4d7d6';

  const toDef = (defId: string | undefined): FileIconDef | null => {
    if (!defId) return null;
    const def = defs[defId];
    if (!def) return null;
    return { glyph: parseGlyph(def.fontCharacter), color: def.fontColor ?? defaultColor };
  };

  const extensionIcons: Record<string, FileIconDef> = {};

  // 1. Bridge-derived entries (lowest precedence). Only keep those whose
  //    language id resolves to a real icon definition.
  for (const [ext, langId] of Object.entries(EXTENSION_LANGUAGE_BRIDGE)) {
    const def = toDef(theme.languageIds[langId]);
    if (def) extensionIcons[ext.toLowerCase()] = def;
  }

  // 2. Direct file-extension entries override the bridge.
  for (const [ext, defId] of Object.entries(theme.fileExtensions)) {
    const def = toDef(defId);
    if (def) extensionIcons[ext.toLowerCase()] = def;
  }

  const filenameIcons: Record<string, FileIconDef> = {};
  // Bridge-derived (lowest precedence).
  for (const [name, langId] of Object.entries(FILENAME_LANGUAGE_BRIDGE)) {
    const def = toDef(theme.languageIds[langId]);
    if (def) filenameIcons[name.toLowerCase()] = def;
  }
  // Direct theme file-name entries override the bridge.
  for (const [name, defId] of Object.entries(theme.fileNames)) {
    const def = toDef(defId);
    if (def) filenameIcons[name.toLowerCase()] = def;
  }

  return {
    extensionIcons,
    filenameIcons,
    defaultIcon: { glyph: parseGlyph(defaultDef?.fontCharacter ?? '\\E023'), color: defaultColor },
  };
}

/** Render a record as compact multi-entry lines to stay under the LOC cap. */
function renderRecord(name: string, record: Record<string, FileIconDef>): string {
  const entries = Object.keys(record)
    .sort()
    .map((key) => {
      const { glyph, color } = record[key];
      return `[${JSON.stringify(key)}, { glyph: '${glyphEscape(glyph)}', color: '${color}' }]`;
    });

  // Pack entries onto lines ~110 chars wide.
  const lines: string[] = [];
  let current = '';
  for (const entry of entries) {
    const candidate = current ? `${current}, ${entry}` : entry;
    if (candidate.length > 110 && current) {
      lines.push(`  ${current},`);
      current = entry;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(`  ${current},`);

  return `export const ${name}: Record<string, FileIconDef> = Object.fromEntries([\n${lines.join('\n')}\n]);`;
}

function generate(theme: SetiTheme): string {
  const { extensionIcons, filenameIcons, defaultIcon } = buildMaps(theme);

  return `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by \`scripts/generate-seti-icon-map.ts\` from the vendored VS Code
 * Seti icon theme (\`src/renderer/assets/icons/seti/vs-seti-icon-theme.json\`,
 * MIT — see the LICENSE.md beside it). Re-run \`npm run generate:file-icons\`
 * to update; never hand-edit.
 *
 * Glyphs are Private-Use-Area code points in the \`seti\` font registered via
 * \`@font-face\` in the global stylesheet.
 */
/* eslint-disable */

export interface FileIconDef {
  /** The Private-Use-Area glyph rendered in the \`seti\` font. */
  glyph: string;
  /** The Seti per-type colour (hex). */
  color: string;
}

${renderRecord('SETI_EXTENSION_ICONS', extensionIcons)}

${renderRecord('SETI_FILENAME_ICONS', filenameIcons)}

export const SETI_DEFAULT_ICON: FileIconDef = { glyph: '${glyphEscape(defaultIcon.glyph)}', color: '${defaultIcon.color}' };
`;
}

function main(): void {
  const check = process.argv.includes('--check');
  const theme = JSON.parse(readFileSync(THEME_FILE, 'utf8')) as SetiTheme;
  const output = generate(theme);

  if (check) {
    let existing = '';
    try {
      existing = readFileSync(OUTPUT_FILE, 'utf8');
    } catch {
      /* missing → drifted */
    }
    if (existing !== output) {
      console.error(
        '[generate-seti-icon-map] file-icon-map.generated.ts is out of date. Run: npm run generate:file-icons',
      );
      process.exit(1);
    }
    console.log('[generate-seti-icon-map] up to date.');
    return;
  }

  writeFileSync(OUTPUT_FILE, output, 'utf8');
  const extCount = Object.keys(buildMaps(theme).extensionIcons).length;
  const nameCount = Object.keys(buildMaps(theme).filenameIcons).length;
  console.log(
    `[generate-seti-icon-map] wrote ${OUTPUT_FILE} (${extCount} extensions, ${nameCount} filenames).`,
  );
}

main();
