#!/usr/bin/env node

/**
 * Hand-reviewed npm advisories that the audit gates accept.
 *
 * Adding an entry is a security decision, not a build fix. Each one records the
 * package, whether it reaches shipped code, what makes the residual risk
 * tolerable, and the concrete change that retires the entry. An advisory with
 * an available upstream fix does not belong here — bump the dependency instead.
 *
 * `scope` is the honest reachability statement, and the two gates read it:
 *   'build'      — absent from the production graph (`npm ls <pkg> --omit=dev`
 *                  is empty). Only `audit:build` can accept these.
 *   'production' — reaches shipped code. Both gates can accept these, and they
 *                  need a compensating control recorded below.
 */
const ADVISORY_REVIEWS = new Map([
  [
    'https://github.com/advisories/GHSA-gcq2-9pq2-cxqm',
    {
      package: 'webpack-dev-server',
      scope: 'build',
      reviewed: '2026-07-25',
      rationale: 'Angular development proxy request-body handling.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
    {
      package: 'brace-expansion',
      scope: 'build',
      reviewed: '2026-07-25',
      rationale:
        'Legacy Minimatch consumers cannot use Brace Expansion v5; every installed copy is '
        + 'pinned to the latest release in its compatible major and exercised.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-r28c-9q8g-f849',
    {
      package: 'postcss',
      scope: 'build',
      reviewed: '2026-07-25',
      rationale: 'Angular build-time source-map loading.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-v56q-mh7h-f735',
    {
      package: 'immutable',
      scope: 'build',
      reviewed: '2026-07-25',
      rationale: "Sass's build-time Immutable.js implementation.",
    },
  ],
  [
    'https://github.com/advisories/GHSA-xvcm-6775-5m9r',
    {
      package: 'immutable',
      scope: 'build',
      reviewed: '2026-07-25',
      rationale: "Sass's build-time Immutable.js implementation.",
    },
  ],
  [
    'https://github.com/advisories/GHSA-x9g3-xrwr-cwfg',
    {
      package: '@angular-devkit/build-angular',
      scope: 'build',
      reviewed: '2026-07-25',
      rationale: 'Angular build-worker option handling.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
    {
      package: 'image-size',
      scope: 'build',
      reviewed: '2026-08-18',
      rationale:
        'ICNS parser infinite loop. Reached only via @angular-devkit/build-angular -> less -> '
        + 'image-size@0.5.5; `npm ls image-size --omit=dev` is empty, so it never ships. Every '
        + 'published version including the 2.0.2 latest is in range, so there is nothing to '
        + 'bump to. Only build-time image assets are parsed, and those are repo-controlled.',
      retiredBy: 'A less/@angular-devkit/build-angular release that drops image-size or moves past 2.0.2.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
    {
      package: 'image-size',
      scope: 'build',
      reviewed: '2026-08-18',
      rationale:
        'JXL/HEIF parser infinite loops in the same build-only image-size@0.5.5 copy as '
        + 'GHSA-w3rx-r6r6-pgpr; identical reachability and identical lack of a fixed version.',
      retiredBy: 'A less/@angular-devkit/build-angular release that drops image-size or moves past 2.0.2.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-jmr9-qjv8-65gv',
    {
      package: 'extract-zip',
      scope: 'production',
      reviewed: '2026-08-18',
      rationale:
        'Unvalidated symlink path traversal, with no patched release (latest 2.0.1 is in range). '
        + 'Two production paths. (1) Our own plugin installer: hardened — '
        + 'src/main/plugins/safe-zip-entry.ts rejects symlink and escaping entries from '
        + "extract-zip's onEntry hook, which runs before anything is written to disk, so a "
        + 'hostile plugin archive is refused rather than extracted. (2) puppeteer-core and '
        + "whatsapp-web.js's bundled puppeteer, which use it only to unpack Chrome-for-Testing "
        + "builds they download themselves over HTTPS from Google's CDN — not attacker-supplied "
        + 'input under normal operation.',
      retiredBy:
        'Upgrading puppeteer-core 22 -> 25 (@puppeteer/browsers 3.x replaced extract-zip with '
        + 'modern-tar) and overriding the nested whatsapp-web.js puppeteer chain, then dropping '
        + 'the direct extract-zip dependency.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-7pqw-9j4j-h8q3',
    {
      package: 'extract-zip',
      scope: 'production',
      reviewed: '2026-09-15',
      rationale:
        'CVE-2026-19693: extract-zip containment-checks only the parent directory of each '
        + 'entry, so a symlink entry pointing outside the destination followed by a regular file '
        + 'with the same name writes through the symlink. No patched release (latest 2.0.1 is in '
        + 'range). Same copy and same two production paths as GHSA-jmr9-qjv8-65gv, and the same '
        + 'controls apply: the attack needs a symlink entry to be created first, and '
        + 'src/main/plugins/safe-zip-entry.ts rejects every symlink entry from onEntry before '
        + 'anything is written (covered by a real-extraction test in '
        + 'plugin-source-resolver.spec.ts); puppeteer only unpacks Chrome-for-Testing builds it '
        + "downloads itself over HTTPS from Google's CDN.",
      retiredBy:
        'Upgrading puppeteer-core 22 -> 25 (@puppeteer/browsers 3.x replaced extract-zip with '
        + 'modern-tar) and overriding the nested whatsapp-web.js puppeteer chain, then dropping '
        + 'the direct extract-zip dependency.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-9f4c-93c8-jc8g',
    {
      package: 'electron',
      scope: 'production',
      reviewed: '2026-08-18',
      rationale:
        'Sandboxed iframe can bypass the allow-popups restriction via the OpenURL navigation '
        + 'path. Fixed in 41.10.3; 40.10.6 is the newest release on the 40 line this app pins, '
        + 'so clearing it needs a major Electron upgrade with a native rebuild and repackage — '
        + 'deliberately not bundled into a dependency-audit fix. Reachable surface is the one '
        + 'sandbox="allow-scripts" iframe in doc-review-viewer.component.ts, which renders '
        + 'locally generated review artifacts. Compensating control: window-manager.ts '
        + "setWindowOpenHandler returns {action: 'deny'} for every URL, so no popup window is "
        + 'created; an http/https URL is instead handed to shell.openExternal. Residual risk is '
        + "therefore an unexpected tab in the user's browser, not in-app code execution.",
      retiredBy: 'Upgrading Electron to >= 41.10.3.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-hq2x-r82h-9wj4',
    {
      package: 'electron',
      scope: 'production',
      reviewed: '2026-10-06',
      rationale:
        'Popups opened from a sandboxed iframe that has allow-popups do not inherit that '
        + 'iframe\'s HTML sandbox. The only sandboxed iframe is doc-review-viewer.component.ts, '
        + 'and its sandbox is "allow-scripts" with neither allow-popups nor allow-same-origin. '
        + 'window-manager.ts setWindowOpenHandler still returns {action: \'deny\'} for every URL, '
        + 'which is the workaround the advisory names. No Electron 40 release contains the fix.',
      retiredBy: 'Upgrading Electron to >= 41.10.4.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-gr2m-v5gq-v685',
    {
      package: 'electron',
      scope: 'production',
      reviewed: '2026-10-06',
      rationale:
        'Windows opened from a sandboxed top-level document do not inherit its HTML sandbox. '
        + 'This app does not load untrusted content as a sandboxed top-level document, and the '
        + 'only BrowserWindow denies every popup via setWindowOpenHandler. The advisory states '
        + 'that workaround is sufficient. No Electron 40 release contains the fix.',
      retiredBy: 'Upgrading Electron to >= 41.10.6.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-j84w-jfhq-vhvj',
    {
      package: 'electron',
      scope: 'production',
      reviewed: '2026-10-06',
      rationale:
        'Custom file or HTTP protocol handlers registered with supportFetchAPI and without '
        + 'corsEnabled can be read cross-origin. The app never calls protocol.registerFileProtocol, '
        + 'protocol.registerHttpProtocol, or protocol.handle. No Electron 40 release contains the fix.',
      retiredBy: 'Upgrading Electron to >= 41.10.6.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-9qh4-3jw8-366w',
    {
      package: 'electron',
      scope: 'production',
      reviewed: '2026-10-06',
      rationale:
        'A <webview> can enable Node.js integration in its workers even when the embedder '
        + 'disabled it. webviewTag is left at the default false, nothing in the repo enables '
        + 'the tag or listens for will-attach-webview, and the main window is created with '
        + 'sandbox: true. The advisory says apps that do not use <webview> are not affected. '
        + 'No Electron 40 release contains the fix.',
      retiredBy: 'Upgrading Electron to >= 41.10.6.',
    },
  ],
  [
    'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
    {
      package: 'braces',
      scope: 'build',
      reviewed: '2026-10-06',
      rationale:
        'Stack exhaustion on deeply nested brace patterns, with no patched release (3.0.3 is '
        + 'the latest and it is inside the vulnerable range). The only parent is micromatch in '
        + 'the dev/build graph; the production audit does not report it. Those patterns come '
        + 'from repository tooling, not from attacker-controlled input.',
      retiredBy: 'A braces release after 3.0.3.',
    },
  ],
]);

/** Advisory URLs a given gate may accept. */
function reviewedAdvisoriesFor(scope) {
  const allowed = new Set();
  for (const [url, review] of ADVISORY_REVIEWS) {
    if (scope === 'build' || review.scope === 'production') allowed.add(url);
  }
  return allowed;
}

module.exports = { ADVISORY_REVIEWS, reviewedAdvisoriesFor };
