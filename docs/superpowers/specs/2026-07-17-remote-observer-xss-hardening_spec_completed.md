# Remote Observer XSS Hardening Specification

Status: Implemented and verified on 2026-07-17

Implementation plan: [2026-07-17-remote-observer-xss-hardening_plan_completed.md](../plans/2026-07-17-remote-observer-xss-hardening_plan_completed.md)

## Problem

The read-only remote observer serves a browser page whose client script renders
instance, repo-job, permission-prompt, message, and observer-URL data. Several of
those values can originate in user input, model output, repository state, or
provider state. The current script concatenates them into `innerHTML` strings.
Only a subset of message fields receives partial HTML escaping, so a persisted
value containing markup can create executable DOM rather than literal text.

The page also has inline JavaScript and CSS and is returned without a Content
Security Policy or referrer policy. Observer URLs carry the read-only bearer
token in the query string, making referrer suppression an important secondary
boundary.

## Design Decision

The observer page will be secure by construction rather than relying on every
current and future caller to remember context-specific escaping.

The implementation will enforce these invariants:

1. Dynamic observer data is rendered with DOM construction and `textContent`.
   The production client contains no `innerHTML`, `outerHTML`, or
   `insertAdjacentHTML` assignment.
2. Snapshot and message payloads remain unchanged. Presentation safety belongs
   at the browser rendering boundary, not in data sanitization that could corrupt
   logs or hide evidence.
3. Browser JavaScript and CSS are served as same-origin static assets. The page
   uses a strict Content Security Policy with no inline-script, inline-style,
   `unsafe-inline`, or `unsafe-eval` allowance.
4. Observer links are parsed and accepted only when their protocol is `http:` or
   `https:`. Links opened in a new tab use `rel="noreferrer"`.
5. Dynamic status classes are selected from an explicit allowlist. Unrecognized
   status text remains visible but cannot become arbitrary class tokens.
6. The page response uses `Referrer-Policy: no-referrer`,
   `X-Content-Type-Options: nosniff`, and clickjacking protection. HTML and API
   responses remain non-cacheable.
7. Existing observer authentication, read-only semantics, snapshot shapes, SSE
   behavior, and API route behavior remain unchanged.

## Components

### Page shell and security policy

A focused observer-page module will own the static HTML shell and its response
headers. It will reference dedicated same-origin stylesheet and client-script
routes so the CSP can use `script-src 'self'` and `style-src 'self'` without a
nonce or inline-code exception.

### Browser client renderer

A separate client asset will own observer rendering. Small DOM helpers will
create elements, assign classes from fixed application constants, set literal
text through `textContent`, and replace container children atomically. URL
rendering will use the platform `URL` parser plus an explicit protocol allowlist.

### Server integration

`RemoteObserverServer` will retain transport, authorization, JSON, and SSE
responsibilities. Its root route will serve the page response and two public,
static asset routes. The assets contain no token or observer data; protected API
routes remain behind the existing bearer/query-token check.

## Verification

- Execute the exact production client asset in JSDOM with hostile strings in
  instance, job, prompt, result, and message fields. Prove the strings appear as
  literal text and create no attacker-selected element or event execution.
- Prove `javascript:` observer URLs are not rendered as links while valid HTTP(S)
  links retain `noreferrer`.
- Enforce the no-HTML-sink invariant against the production client source.
- Verify the page CSP contains only the required same-origin capabilities and no
  unsafe inline/eval allowances.
- Start the real observer server on a loopback test port and verify page and asset
  response headers/content through HTTP.
- Run focused tests, both TypeScript checks, lint, max-LOC, and the full quiet
  suite.

## As-built notes (2026-07-17)

All seven invariants are implemented as specified: the page shell and headers
live in `src/main/remote/observer-page.ts`, the DOM-only browser client in
`src/main/remote/observer-client-script.ts`, the stylesheet in
`src/main/remote/observer-styles.ts`, and `RemoteObserverServer` now serves
`/`, `/observer-client.js`, and `/observer.css` as same-origin assets while the
`/api/*` routes and SSE stay behind the existing token check.

One hardening beyond the spec text, prompted by the independent completion
gate: the pre-existing `Access-Control-Allow-Origin: *` header on the
token-protected SSE route was removed (the only consumer is the same-origin
observer client), with an integration test covering the stream's auth and
header behavior.

Evidence: adversarial JSDOM spec plus real-HTTP spec (6 tests), both TypeScript
checks, lint, max-LOC, `verify:architecture`, and the full quiet suite
(1503 files, 14,848 tests) all pass on the final code in the isolated task-only
worktree; independent gate verdict PASS. Details in the completed plan.

## Non-goals

- Changing observer snapshot or event schemas.
- Changing token generation, token placement, or observer authorization.
- Adding write operations to the observer.
- Sanitizing or truncating stored instance, job, prompt, or message data.
- Redesigning the observer UI.
