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

for (const dir of dirs) {
  const src = path.join(distRoot, 'src', dir);
  const dest = path.join(distRoot, dir);
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true, force: true });
  }
}
