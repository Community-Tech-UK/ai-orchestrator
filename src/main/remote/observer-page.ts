export interface ObserverPageResponse {
  html: string;
  headers: Record<string, string>;
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
].join('; ');

const OBSERVER_PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Orchestrator Observer</title>
    <link rel="stylesheet" href="/observer.css">
    <script src="/observer-client.js" defer></script>
  </head>
  <body>
    <header>
      <div>
        <h2>Read-only Observer</h2>
        <h1>Local Orchestrator</h1>
        <p class="subtitle">Observe local instances, repo jobs, and prompts without write access. This page auto-refreshes through the observer event stream.</p>
      </div>
      <div class="urls" id="observer-urls"></div>
    </header>

    <section class="toolbar">
      <label>
        Selected Instance
        <select id="instance-select"></select>
      </label>
      <button class="secondary" id="refresh-btn" type="button">Refresh Snapshot</button>
      <button class="primary" id="open-replay-btn" type="button">Open Replay JSON</button>
    </section>

    <section class="stats" id="stats"></section>

    <section class="grid">
      <article class="panel">
        <div class="panel-header">
          <h3>Instances</h3>
          <span class="meta" id="instance-count">0</span>
        </div>
        <div class="panel-list" id="instance-list"></div>
      </article>

      <article class="panel">
        <div class="panel-header">
          <h3>Repo Jobs</h3>
          <span class="meta" id="job-count">0</span>
        </div>
        <div class="panel-list" id="job-list"></div>
      </article>

      <article class="panel">
        <div class="panel-header">
          <h3>Live Detail</h3>
          <span class="meta" id="detail-title">Select an instance</span>
        </div>
        <div class="detail-list" id="detail-list"></div>
        <div class="message-list" id="message-list"></div>
      </article>
    </section>
  </body>
</html>`;

export function buildObserverPageResponse(): ObserverPageResponse {
  return {
    html: OBSERVER_PAGE_HTML,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  };
}
