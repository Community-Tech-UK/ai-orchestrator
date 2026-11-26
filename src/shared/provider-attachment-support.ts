/** Keep in sync with adapters: these providers reject attachment payloads. */
export function providerAcceptsAttachments(provider: string): boolean {
  return provider !== 'gemini'
    && provider !== 'antigravity'
    && provider !== 'local-model'
    && provider !== 'ollama';
}
