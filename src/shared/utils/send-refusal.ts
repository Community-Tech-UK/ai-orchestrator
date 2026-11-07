/** Only explicit refusals before acceptance are safe to replay automatically. */
export function isKnownSendRefusal(message: string): boolean {
  const text = message.toLowerCase();
  return ['not ready', 'not spawned', 'respawning after interrupt', 'recovering from interrupt',
    'interrupt recovery', 'cannot send while compacting', 'previous turn is still running', 'runtime already has an active turn',
    'activeturnnotsteerable', 'queued input is waiting for the provider limit',
    'failed to submit turn input: thread busy',
    // Main waits for a starting, waking or respawning session inside the send; when that wait runs out the
    // message was never handed over, and the renderer must queue it again (instance-input-ready.ts).
    'instance initialization timed out', 'instance wake timed out', 'instance respawn timed out',
    'is recovering. please wait for it to be ready'].some(signature => text.includes(signature));
}

/** ACP/exec adapters keep the send promise open for the entire provider turn. */
export function getSendInputTimeoutMs(provider: string | undefined): number | null {
  return provider && ['codex', 'cursor', 'copilot', 'grok', 'opencode'].includes(provider) ? null : 60_000;
}
