/**
 * Token- and spend-lever settings: the controls that bound or cheapen what a
 * session costs to run — helper-agent models, tool-output caps, context
 * ceilings, compaction cost caps and cold-cache compaction — plus RTK's
 * shell-output shortening (the Phase 1 token-levers family).
 *
 * Extracted from `settings.types.ts` (LOC ratchet split) as an `AppSettings`
 * fragment in the `ObservationSettings` idiom.
 */
export interface TokenLeverSettings {
  /**
   * Cost-cap compaction trigger (claude2_todo #34b): auto-compact an instance
   * once its cumulative token spend *since the last compaction* exceeds this
   * many tokens, independent of context-window fill %. Catches long sessions
   * (incl. self-managing CLIs that keep the window small while cost climbs).
   * 0 = disabled.
   */
  cumulativeTokenCompactionTrigger: number;
  ownChatContextCeilingTokens: number;
  machineContextCeilingTokens: number;
  codexHelperAgentsChats: 'economy' | 'full' | 'off' | 'trial';
  codexHelperAgentsHarnessWork: 'off' | 'full' | 'trial';
  codexContextTuning: 'harness' | 'codex';
  /** Default model for Claude's built-in general-purpose helpers. */
  claudeHelperAgentModel: 'parent' | 'sonnet' | 'trial';
  /** Characters of successful Bash output Claude sees directly; 0 uses its own limit. */
  claudeBashOutputMaxChars: number;
  /** Restart-with-summary compaction also records and injects a heuristic decision log. Default off. */
  compactionDecisionLogEnabled: boolean;
  coldCacheCompactFirst: boolean; // Offer a real summary before sending into a large, cold Claude conversation.
  // RTK shortens long shell output before the AI reads it; users can opt out on the Savings tab.
  rtkEnabled: boolean;
  /** When true, never use a system-installed rtk; only the bundled binary. */
  rtkBundledOnly: boolean;
  /** Rewrite-only RTK hook for auto-approve Claude sessions and loops. */
  rtkAutoApproveScope: 'off' | 'trial' | 'on' | 'sessions-only';
}
