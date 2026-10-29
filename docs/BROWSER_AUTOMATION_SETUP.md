# Browser Automation Setup for AI Orchestrator

This guide explains how to enable browser automation capabilities for Claude instances spawned by the orchestrator.

## The Problem

When Claude Code opens a browser window directly, it shows "Debugging by Claude" and can interact with the page. However, child instances spawned by AI Orchestrator don't have this capability by default because they run as separate CLI processes.

## Solution: Chrome DevTools MCP

The solution is to configure the **Chrome DevTools MCP server** in your Claude Code settings. Once configured, all Claude instances (including children spawned by the orchestrator) will have access to browser automation tools.

## Quick Setup

### In-App Path

Open the MCP page in AI Orchestrator and use the **Browser Automation** card:

1. Click **Add Chrome DevTools Preset**
2. Connect the `chrome-devtools` server from the server list
3. Click **Test Browser Tooling** to verify runtime, config, and discovered browser tools

The in-app health check also inspects your Claude Code user settings so you can tell whether browser access is coming from the orchestrator MCP registry, your existing Claude MCP setup, or both.

### Option 1: CLI Command (Recommended)

Run this command to add Chrome DevTools MCP to your Claude Code configuration:

```bash
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest
```

This adds the MCP server with user scope, making it available to all Claude sessions.

### Option 2: Manual Configuration

Add the MCP server to your Claude Code settings file.

**Location:** `~/.claude/settings.json` or `~/.config/claude/settings.json`

Add this to your `mcpServers` configuration:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

## Requirements

### 1. Chrome Browser

Chrome must be installed on your system.

### 2. Remote Debugging (for connecting to existing Chrome)

If you want Claude to connect to an already-running Chrome instance (useful for authenticated sessions), launch Chrome with remote debugging enabled:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug-profile

# Linux
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug-profile

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir=C:\temp\chrome-debug-profile
```

### 3. Node.js and npm

The MCP server runs via `npx`, so Node.js must be installed.

## Available Tools

Once configured, Claude instances will have access to these browser automation tools:

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_screenshot` | Take a screenshot of the page |
| `browser_click` | Click on an element |
| `browser_type` | Type text into an input field |
| `browser_press_key` | Press a named key (Tab, Shift+Tab, Enter, Escape, arrows) with real keyboard input and modifiers |
| `browser_set_viewport` | Set or read the content viewport in CSS pixels (tab-scoped emulation, optional real window resize) |
| `browser_set_zoom` | Set, read or reset real Chrome browser zoom (1 = 100%, 2 = 200%) |
| `browser_handle_dialog` | Answer a Chrome page pop-up (alert, confirm, "Leave site?") that opened while a gateway command ran on a shared tab |
| `browser_scroll` | Scroll the page |
| `browser_evaluate` | Execute JavaScript in the page |
| `browser_console_logs` | Get console logs from the page |
| `browser_network_requests` | Inspect network requests |

## Verifying the Setup

After configuration, restart Claude Code and ask it to list its available tools. You should see the browser tools in the list.

You can also test by asking Claude to:

```
Navigate to https://example.com and take a screenshot
```

## Using with Orchestrator Children

Once Chrome DevTools MCP is configured, child instances spawned by the orchestrator automatically inherit the MCP configuration. No additional setup is needed.

Example orchestrator command to spawn a child for browser testing:

```
:::ORCHESTRATOR_COMMAND:::
{
  "action": "spawn_child",
  "task": "Navigate to https://myapp.local:3000 and test the login form with username 'test@example.com' and password 'testpass123'. Report any console errors.",
  "name": "browser-tester"
}
:::END_COMMAND:::
```

## Troubleshooting

### "Chrome DevTools MCP not found"

1. Verify Node.js is installed: `node --version`
2. Try installing the package globally: `npm install -g chrome-devtools-mcp`
3. Check your Claude settings file for syntax errors

### "Cannot connect to Chrome"

1. Ensure Chrome is running with remote debugging enabled
2. Verify port 9222 is not blocked by a firewall
3. Check if another process is using port 9222: `lsof -i :9222`

### "Permission denied" errors

1. On macOS, you may need to grant terminal access to Chrome in System Preferences > Privacy & Security
2. Ensure the user data directory is writable

### Children can't access browser tools

1. Verify the MCP is configured at user scope (not project scope)
2. Check that the child's working directory doesn't have conflicting MCP settings
3. Restart the orchestrator after making configuration changes

## Alternative: Puppeteer MCP

If Chrome DevTools MCP doesn't meet your needs, you can also use the Puppeteer MCP server:

```bash
claude mcp add puppeteer -- npx -y @anthropic/mcp-server-puppeteer
```

This provides similar browser automation capabilities with a different tool set.

## Security Considerations

- Browser automation tools have powerful capabilities. Be careful about which URLs you allow Claude to navigate to.
- When using authenticated sessions (via `--user-data-dir`), Claude will have access to your logged-in sessions.
- Consider using a separate Chrome profile for automation to isolate from your personal browsing data.

## References

- [Chrome DevTools MCP GitHub](https://github.com/anthropics/mcp-server-chrome-devtools)
- [Claude Code MCP Documentation](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Chrome Remote Debugging Protocol](https://chromedevtools.github.io/devtools-protocol/)
