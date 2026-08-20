import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The renderer used to pull its webfonts straight from Google. That made
 * `ng build --configuration production` fail outright whenever
 * fonts.googleapis.com was unreachable, because Angular's font inliner fetches
 * the stylesheet at build time:
 *
 *   ✘ [ERROR] Failed to inline external stylesheet
 *     'https://fonts.googleapis.com/css2?family=JetBrains+Mono...'
 *
 * It also left the packaged desktop app fetching woff2 subsets from
 * fonts.gstatic.com on every cold start, so the UI lost its typography offline.
 *
 * Fonts are now vendored by `scripts/vendor-google-fonts.js`. These guards keep
 * the build hermetic and stop a remote font reference reappearing.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const STYLES_DIR = join(REPO_ROOT, 'src', 'renderer', 'styles');
const FONTS_DIR = join(STYLES_DIR, 'fonts');
const FONTS_PARTIAL = join(STYLES_DIR, '_fonts.scss');
const INDEX_HTML = join(REPO_ROOT, 'src', 'renderer', 'index.html');

const REMOTE_FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

function styleFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return walk(full);
      }
      return entry.name.endsWith('.scss') || entry.name.endsWith('.css') ? [full] : [];
    });
  return walk(join(REPO_ROOT, 'src', 'renderer'));
}

describe('renderer fonts are self-hosted', () => {
  it('has no renderer stylesheet fetching fonts from a remote host', () => {
    const offenders = styleFiles().filter((file) => {
      // Drop whole-line `//` comments only. Anything narrower (e.g. stripping
      // from the first `//` on a line) would eat the `//` in `https://` and
      // blind this guard to the exact import it exists to catch.
      const source = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      return REMOTE_FONT_HOSTS.some((host) => source.includes(host));
    });

    expect(offenders.map((file) => file.replace(`${REPO_ROOT}/`, ''))).toEqual([]);
  });

  it('does not allow remote font origins in the renderer CSP', () => {
    const html = readFileSync(INDEX_HTML, 'utf8');
    for (const host of REMOTE_FONT_HOSTS) {
      expect(html).not.toContain(host);
    }
  });

  it('declares every face against a vendored woff2 that exists on disk', () => {
    expect(existsSync(FONTS_PARTIAL)).toBe(true);
    const partial = readFileSync(FONTS_PARTIAL, 'utf8');

    const faces = partial.match(/@font-face\s*\{/g) ?? [];
    expect(faces.length).toBeGreaterThan(0);

    const referenced = [...partial.matchAll(/url\('\.\/fonts\/([^']+)'\)/g)].map(
      (match) => match[1],
    );
    expect(referenced.length).toBe(faces.length);

    for (const file of new Set(referenced)) {
      expect(existsSync(join(FONTS_DIR, file)), `missing vendored font ${file}`).toBe(true);
    }
  });

  it('ships no vendored woff2 that the partial does not reference', () => {
    const partial = readFileSync(FONTS_PARTIAL, 'utf8');
    const referenced = new Set(
      [...partial.matchAll(/url\('\.\/fonts\/([^']+)'\)/g)].map((match) => match[1]),
    );
    const onDisk = readdirSync(FONTS_DIR).filter((file) => file.endsWith('.woff2'));

    expect(onDisk.sort()).toEqual([...referenced].sort());
  });

  /**
   * Both families are SIL OFL 1.1, which allows bundling only while the
   * copyright notice and licence text ship with the fonts. Vendoring the
   * binaries without them would put the repo out of compliance, and that is
   * exactly the kind of omission nobody notices until it matters.
   */
  it('ships the OFL notice alongside the vendored fonts', () => {
    const attribution = join(FONTS_DIR, 'LICENSE.md');
    expect(existsSync(attribution), 'missing fonts/LICENSE.md').toBe(true);

    for (const licence of ['OFL-JetBrainsMono.txt', 'OFL-IBMPlexSans.txt']) {
      const full = join(FONTS_DIR, licence);
      expect(existsSync(full), `missing ${licence}`).toBe(true);
      expect(readFileSync(full, 'utf8')).toContain('SIL Open Font License');
    }

    // Each vendored family must be named in the attribution, so a future
    // family added to the partial cannot slip in unattributed.
    const partial = readFileSync(FONTS_PARTIAL, 'utf8');
    const families = new Set(
      [...partial.matchAll(/font-family:\s*'([^']+)'/g)].map((match) => match[1]),
    );
    const notice = readFileSync(attribution, 'utf8');
    for (const family of families) {
      expect(notice, `${family} is vendored but not attributed`).toContain(family);
    }
  });

  /**
   * The OFL requires the notice to travel with each redistributed copy, and the
   * packaged desktop app redistributes these fonts. The woff2 files reach the
   * bundle through esbuild (they are `url()`-referenced), but plain text files
   * are not, so they need an explicit assets entry or they silently stay behind.
   */
  it('copies the font licences into the built bundle', () => {
    const angularJson = JSON.parse(readFileSync(join(REPO_ROOT, 'angular.json'), 'utf8'));
    const assets =
      angularJson.projects['ai-orchestrator'].architect.build.options.assets ?? [];

    const shipsLicences = assets.some(
      (asset: { input?: string; glob?: string }) =>
        asset.input === 'src/renderer/styles/fonts' && /OFL|LICENSE/.test(asset.glob ?? ''),
    );

    expect(shipsLicences, 'angular.json does not copy fonts/LICENSE.md + OFL-*.txt').toBe(true);
  });
});
