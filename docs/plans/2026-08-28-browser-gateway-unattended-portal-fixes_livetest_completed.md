# Live tests — Browser Gateway unattended portal fixes

## Status — completed by live execution and residual transfer 2026-09-27

Open: 0 · Closed: 2 · Transferred residual campaign: 1 · Failed: 0

Checks 1 and 2 passed through the loaded extension on `windows-pc`. Check 3 exposed LT-658, which
was fixed and regression-tested as extension v0.2.37. Its unaffected plain-`div`, rich-text and
multi-select assertions passed live; the two post-reload disabled/readonly assertions moved to
[RES-023](2026-09-27-livetest-human-external-residuals_livetest.md#res-023--reload-browser-gateway-v0237-and-confirm-lt-658-live).

> **Found a defect while running these checks?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-08-28-browser-gateway-unattended-portal-fixes_plan_completed.md](./2026-08-28-browser-gateway-unattended-portal-fixes_plan_completed.md)

## Why these are deferred

All three defects are fixed in code and covered in-loop:

- Defect 1 (staged upload renamed the file) — `browser-remote-upload-staging.spec.ts` covers
  spaces, brackets, accents, emoji/surrogate pairs, dotfiles, Windows reserved device names,
  truncation, and POSIX-vs-Windows node roots.
- Defect 2 (accessibility snapshot stopped at the iframe boundary) —
  `browser-extension-accessibility-frames.spec.ts` covers frame-tree walking, per-frame AX
  capture, de-duplication, the shared deadline, and per-frame failure.
- Defect 3 (`type` reported success on a non-typeable target) — covered by the same extension
  suite: element-ness, typeability, the multi-select `option.selected` path, and the honest
  refusal message.

Those are **not** deferred and must not be re-listed here. What is left cannot run in-loop:
`chrome.debugger` behaviour inside a *loaded* extension cannot be exercised headlessly
(extensions do not load in headless Chrome), and no fixture substitutes for the real portal DOM.

## Prerequisites

- `npm run build:main` and `npm run build:renderer`, then relaunch AIO. **James's call and
  timing** — the restart drops the current Browser Gateway session.
- Reload the Chrome extension on `windows-pc`, then confirm the node reports the
  `version` currently in `resources/browser-extension/manifest.json`. Read the version from the
  manifest, not from this document. Anything older means the reload did not take and every check
  below it is invalid.

---

## Check 1 — a staged upload reaches the page under its real filename

**Steps.** With a real file whose name contains spaces and a bracketed suffix, run an upload to a
file input on a remote page via `browser.upload_file` against `windows-pc`.

**Expected.** The page's file input, and anything the page subsequently submits, shows the
original basename byte-for-byte. No UUID prefix appears in the visible filename. The UUID appears
only as an intermediate directory component of the staged remote path.

**Why not in-loop.** The unit test proves the path this code builds; only a real
`DOM.setFileInputFiles` against a real input proves what the page actually displays.

**Result — passed 2026-09-27.** On Selenium's public upload fixture,
`browser.upload_file` selected the coordinator file `original report [final].txt` through the
loaded `windows-pc` extension. Read-back showed exactly
`C:\\fakepath\\original report [final].txt` (audit
`2dfbddc6-cc4e-4bf9-afc0-78015817286b`), and the harmless fixture submission rendered
`File Uploaded!` with the exact basename (audit `c7821796-9355-4455-9bc8-011bd6aa5b01`). No UUID
prefix reached the page.

---

## Check 2 — the accessibility snapshot reaches content inside an iframe

**Steps.** On a page whose editable body is inside an iframe (ProContract's TinyMCE editor is the
motivating case), call `browser.snapshot` / the accessibility snapshot through the loaded
extension on `windows-pc`.

**Expected.** The merged snapshot contains the iframe's editable body as a typeable target, not
just the `Iframe` node and its `StaticText`. Nodes are de-duplicated across frames. A frame that
cannot be read is skipped without failing the whole capture.

**Why not in-loop.** Round 2 verified the CDP primitives against real Chrome, but not through
`chrome.debugger` in a loaded extension, and not against the real portal DOM.

**Result — passed 2026-09-27.** ProContract's authenticated session expired before the editor page
could be reached, so the same extension path was exercised against TinyMCE's public live demo.
The merged accessibility snapshot contained the iframe plus its child editable node (`uid: 55`,
`editable: "richtext"`, accessible name `Rich Text Area. Press ALT-0 for help.`) and the full
editor value (audit `c82545e2-3d9f-4212-b07b-ebc082795066`). A second snapshot confirmed the same
frame merge (audit `6f785592-9baf-4256-afe4-a319cda96714`). The whole capture succeeded despite a
separate unreadable nested iframe in the page.

---

## Check 3 — `type` fails loudly on a non-typeable target

**Steps.** Against a real page, call the type operation on: a disabled input, a readonly input, a
plain `div`, a `contenteditable` host, and a multi-select.

**Expected.** Disabled/readonly/plain-`div` targets return an explicit failure naming the tag and
pointing at the remedy — never a success result. The `contenteditable` host accepts the text. The
multi-select selects the requested option *without* deselecting the others.

**Why not in-loop.** The guard logic is unit-covered; what needs a real page is that the refusal
surfaces to the caller as a failure rather than being swallowed by the extension transport.

**Result — partially passed, defect fixed, residual transferred 2026-09-27.**

- A plain `.container` `div` failed explicitly rather than reporting success (audit
  `4b81b957-40e2-4318-9d0d-ab464fdd4b33`).
- TinyMCE's iframe-backed editable body accepted `LT contenteditable probe 2026-09-27` (write audit
  `3826269b-61e4-4e9b-8025-d9c39fe8cf5a`); a follow-up accessibility snapshot showed that exact
  value and `editable: "richtext"`. The disposable page was then reloaded successfully (audit
  `ea2806b7-183e-4ae5-a478-9f242980a7e9`).
- Selenium's `#invisible_multi_select` began with Apples and Lemons selected. Typing `pears`
  succeeded (audit `23edf318-9712-4c16-9353-eb295572d314`), and read-back showed Apples, Pears and
  Lemons all selected (audit `7f2f6dd9-f260-4a86-a57a-82d3217f1339`).
- The loaded v0.2.36 extension incorrectly reported success and changed the values of both a
  disabled input and a readonly input (audits `08316ae9-09ca-4676-8ab6-d9345cd80d90` and
  `98045bc3-0c2e-432a-86ef-7216d447bb18`; unchanged-state contradiction proved by audit
  `1248b85f-3084-4bf8-963b-b94a1ca73744`). This was registered as LT-658. Both extension type
  paths now reject disabled/readonly native controls before mutation; manifest v0.2.37 identifies
  the new bundle, and the focused extension suites pass 148/148. The Browser Gateway has no
  agent-side operation for reloading an unpacked extension, so the two live confirmations moved to
  RES-023 rather than keeping this five-part historical check open.
