export interface McpServerToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
  /**
   * When true, the server inspects the handler result for base64 image bytes
   * (a `data` field) and emits an MCP `image` content block so MCP clients can
   * render the screenshot visually, instead of serializing the base64 into an
   * unreadable `text` block. Falls back to text when no image data is present
   * (e.g. a failed capture). Set on `browser.screenshot`.
   */
  producesImage?: boolean;
}
