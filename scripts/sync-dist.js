/**
 * sync-dist.js
 *
 * After tsc compiles with rootDir "." the output lands under dist/src/.
 * The app expects dist/main/, dist/preload/, dist/shared/.
 * This script copies from dist/src/<dir> into dist/<dir> so both layouts
 * are available — keeping backward compatibility with package.json "main"
 * and electron-builder configs.
 */

const fs = require('fs');
const path = require('path');

const distRoot = path.join(__dirname, '..', 'dist');
const dirs = ['main', 'preload', 'shared'];

for (const dir of dirs) {
  const src = path.join(distRoot, 'src', dir);
  const dest = path.join(distRoot, dir);
  if (fs.existsSync(src)) {
    fs.cpSync(src, dest, { recursive: true, force: true });
  }
}
