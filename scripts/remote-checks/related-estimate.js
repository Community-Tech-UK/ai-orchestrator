'use strict';
/**
 * A quick guess at how many spec files a change reaches, by following imports backwards.
 * Vitest's own answer means transforming every spec file, which is the work this is trying
 * to keep off a busy Mac. The guess only decides where the tests run: Vitest still chooses
 * which tests, so being a little out moves a run, and never skips one.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.js', '*.mjs', '*.cjs'];
const RESOLVED_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'];
const SPEC_NAME = /\.(?:spec|test)\.[cm]?[jt]sx?$/;
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bvi\.(?:do)?(?:mock|unmock)\s*\(\s*|\bimportActual(?:<[^>]*>)?\s*\(\s*)['"`]([^'"`\n]+)['"`]/g;

/** `"@alias/*": ["./path/*"]` lines, read as text because the file isn't strict JSON. */
function readAliases(root) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8');
  } catch {
    /* a project with no aliases */
  }
  const entries = [...text.matchAll(/"(@[^"]+)":\s*\["\.\/([^"]+)"\]/g)].map(match => [match[1], match[2]]);
  return {
    exact: new Map(entries.filter(([name]) => !name.endsWith('*'))),
    prefixes: entries.filter(([name]) => name.endsWith('*')).map(([name, target]) => [name.slice(0, -1), target.slice(0, -1)]),
  };
}

function makeResolver(files, aliases) {
  const known = (base) => {
    for (const suffix of RESOLVED_SUFFIXES) if (files.has(base + suffix)) return base + suffix;
    const asTypeScript = base.replace(/\.js$/, '.ts');
    return files.has(asTypeScript) ? asTypeScript : null;
  };
  return (from, specifier) => {
    if (specifier.startsWith('.')) return known(path.posix.join(path.posix.dirname(from), specifier));
    if (aliases.exact.has(specifier)) return known(aliases.exact.get(specifier));
    const prefix = aliases.prefixes.find(([name]) => specifier.startsWith(name));
    return prefix ? known(prefix[1] + specifier.slice(prefix[0].length)) : null;
  };
}

/** Spec files that import any of `changed`, directly or through other files. */
function estimateRelatedSpecs(root, changed) {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ...SOURCE_GLOBS], {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\0').filter(Boolean);
  const resolve = makeResolver(new Set(listed), readAliases(root));

  const importers = new Map();
  for (const file of listed) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const [, specifier] of text.matchAll(IMPORT)) {
      const target = resolve(file, specifier);
      if (!target) continue;
      if (!importers.has(target)) importers.set(target, []);
      importers.get(target).push(file);
    }
  }

  const reached = new Set(changed);
  const pending = [...changed];
  while (pending.length) {
    for (const importer of importers.get(pending.pop()) ?? []) {
      if (!reached.has(importer)) {
        reached.add(importer);
        pending.push(importer);
      }
    }
  }
  return [...reached].filter(file => SPEC_NAME.test(file)).length;
}

module.exports = { estimateRelatedSpecs };
