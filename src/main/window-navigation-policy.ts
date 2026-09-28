/**
 * Main-window navigation policy.
 *
 * The main window only ever hosts the Angular app document. Angular routing is
 * same-document (history API), so it never reaches `will-navigate`. Any
 * cross-document navigation is therefore leaving the app, and it replaces the
 * whole UI with a blank error page that a reload cannot recover (reload
 * reloads the bad URL). Example: a relative markdown link such as
 * `docs/guide.docx` resolves against the renderer's `file://` base URL.
 */

/**
 * Returns true when `targetUrl` still points at the app document described by
 * `appUrl`: the same origin for a dev server, or the exact `index.html` file
 * (query and hash ignored) for a packaged build.
 */
export function isAppDocumentNavigation(targetUrl: string, appUrl: string): boolean {
  let target: URL;
  let app: URL;
  try {
    target = new URL(targetUrl);
    app = new URL(appUrl);
  } catch {
    return false;
  }

  if (app.protocol === 'file:') {
    return target.protocol === 'file:'
      && target.host === app.host
      && decodePathname(target.pathname) === decodePathname(app.pathname);
  }

  return target.origin === app.origin;
}

function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}
