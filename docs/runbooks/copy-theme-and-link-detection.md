# Copy, Theme, And Link Detection Runbook

Use this runbook when copy behavior, theme switching, or transcript links drift.

## Clipboard Service

Renderer text and JSON copy paths go through the shared `ClipboardService`. Image copy remains delegated to the native image IPC path. Consumers opt into success or error UI; there is no mandatory global toast.

## Copy Failures

If text copy fails, check the caller's `copyText` result and the user-facing reason. Do not add direct `navigator.clipboard.writeText` fallbacks; fix the shared service or its DI setup.

## Theme Listener

When theme is set to `system`, the renderer follows the operating-system appearance without restart. If it does not update, check the settings value, the system-theme listener, and CSS variables before changing individual components.

## Link Types

Transcript link detection covers:

- URLs.
- Absolute and relative POSIX paths.
- Windows paths and UNC paths.
- Error traces such as `at /path/file.ts:12:4`.

Path links should resolve through the shared open-file/editor path instead of embedding component-specific open logic.

## Terminal Drawer Scope

The terminal drawer is a boundary/scaffold surface. Treat deeper terminal runtime behavior as follow-up work unless a task explicitly targets it.
