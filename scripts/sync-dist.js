/**
 * sync-dist.js
 *
 * After tsc compiles with rootDir "." the output lands under dist/src/.
 * The app expects dist/main/, dist/preload/, dist/shared/.
 * This script copies from dist/src/<dir> into dist/<dir> so both layouts
 * are available — keeping backward compatibility with package.json "main",
 * electron-builder configs, and main-process imports into shared worker-agent
 * runtime modules.
 */

const fs = require('fs');
const path = require('path');

const distRoot = path.join(__dirname, '..', 'dist');
const dirs = ['main', 'preload', 'shared', 'worker-agent'];

// TypeScript does not emit non-code assets. Copy doc-review's self-contained template
// and portable capture server into the compiled tree before mirroring dist/src/main to
// dist/main, so both development builds and packaged apps carry the tracked assets.
const docReviewAssets = path.join(__dirname, '..', 'src', 'main', 'doc-review', 'assets');
const compiledDocReviewAssets = path.join(distRoot, 'src', 'main', 'doc-review', 'assets');
if (fs.existsSync(docReviewAssets)) {
  fs.cpSync(docReviewAssets, compiledDocReviewAssets, { recursive: true, force: true });
}

// Built-in skill bundles are SKILL.md files (plus reference/example assets) —
// non-code, so tsc never emits them. SkillRegistry.getBuiltinSkillsPath()
// resolves `path.join(__dirname, 'builtin')` inside the COMPILED tree, so
// without this copy the directory simply does not exist and every build
// discovers zero builtin skills, leaving the whole skills feature dark
// (LT-009). Colocated *.spec.ts files are tests, not bundle assets.
const builtinSkills = path.join(__dirname, '..', 'src', 'main', 'skills', 'builtin');
const compiledBuiltinSkills = path.join(distRoot, 'src', 'main', 'skills', 'builtin');
if (fs.existsSync(builtinSkills)) {
  fs.cpSync(builtinSkills, compiledBuiltinSkills, {
    recursive: true,
    force: true,
    filter: (src) => !src.endsWith('.ts'),
  });
}

for (const dir of dirs) {
  const src = path.join(distRoot, 'src', dir);
  const dest = path.join(distRoot, dir);
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true, force: true });
  }
}

// Assert the non-code assets actually landed in the tree Electron loads
// (package.json "main" is dist/main/main-process-entry.js). Unit tests cannot catch a
// missing asset here — under vitest `__dirname` resolves to the SOURCE tree, so
// discovery passes there while the real app finds nothing. Fail the build
// loudly instead of shipping a silently dark feature (LT-009).
function assertNonEmptyDir(dir, what) {
  if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
    console.error(`sync-dist: ${what} missing or empty after copy: ${dir}`);
    process.exit(1);
  }
}

if (fs.existsSync(builtinSkills)) {
  assertNonEmptyDir(path.join(distRoot, 'main', 'skills', 'builtin'), 'built-in skill bundles');
}
if (fs.existsSync(docReviewAssets)) {
  assertNonEmptyDir(path.join(distRoot, 'main', 'doc-review', 'assets'), 'doc-review assets');
}
