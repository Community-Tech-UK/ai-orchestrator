# Browser Gateway — RPC timeout cascade (follow-up #11)

Discovered 2026-06-02 from a **live** end-to-end test (Apple Developer portal)
after the original 10 extension-side issues were fixed. The original fixes are in
`resources/browser-extension/KNOWN_ISSUES_completed.md` (closed). This is a
separate, gateway-layer issue surfaced only by running the real flow.

## Symptom

Screenshots and `list_targets` worked, but the **action channel**
(`navigate` / `click` / `query_elements`) returned `browser_gateway_unavailable`
— `query_elements` consistently, `navigate`/`click` intermittently ("cleared on
retry"). A live agent mis-attributed this to the native-host bridge flapping.

## Root cause — a timeout cascade

`browser_gateway_unavailable` is emitted by the MCP-bridge **RPC client**
(`browser-gateway-rpc-client.ts`) on socket-connect failure or request timeout —
*before* a command reaches the native host. (A missing route would instead
return `browser_gateway_service_method_unavailable`; a dead parent fails fast via
a socket error, not a timeout.) The client's flat **15s** timeout was shorter
than every layer it wrapped:

| Layer | Budget |
|-------|--------|
| MCP RPC client (bridge → parent) | **15s** ← bottleneck |
| Extension command store (parent → extension) | 30s |
| `wait_for` | ≤120s |
| `download_file` | ≤60s |
| MCP host tool timeout | Gemini 30s · Codex 60s · Claude ~60s default |

So any operation legitimately taking >15s surfaced as a misleading
"unavailable". `query_elements` (now `allFrames`, heavier on complex pages) and
`navigate` (builds an all-frames snapshot + screenshot before returning, after
waiting up to 15s for load) routinely cross 15s. Fast ops (screenshot, CDP) stay
under 15s and worked — exactly the observed pattern.

## Fix

- `browser-gateway-rpc-client.ts`: default timeout 15s → **45s**; `wait_for` /
  `download_file` derive their socket timeout from `payload.timeoutMs + 15s`
  (capped at 130s) so a wait can outlive its own budget. Raising the timeout is
  cost-free in the unavailable case — a dead parent still rejects instantly on
  the socket error.
- `browser-mcp-config.ts`: Gemini host `timeout` 30s → 130s; Codex
  `tool_timeout_sec` 60 → 130 — so providers don't cap long-but-valid calls.
- Regression test in `browser-gateway-rpc-client.spec.ts`: a slow mock server
  proves a `wait_for` survives a base timeout that kills a normal call.

Verified: `tsc` (app + spec) clean, lint clean, browser-gateway suite 159/159.

## To take effect (rebuild required — not an extension reload)

These changes are in `src/main`, compiled into the **`aio-mcp` SEA binary** the
bridge runs as, and into the main-process MCP-config generator:

1. `npm run build:aio-mcp-dist` — rebuild the bridge binary (contains the RPC client).
2. Restart the app (or `npm run dev`) so main picks up the config-generator change.
3. Launch a **fresh** agent instance so its MCP config is regenerated with the new
   host timeouts, then re-share the Chrome tab.

## Watch-item

If `query_elements` still times out at the 30s command-store budget on very
heavy pages (it would now fail as `browser_extension_command_timeout`, not
`unavailable`), the next step is to bound the `allFrames` candidate scan
(cap frames/elements, cheaper unique-selector generation).
