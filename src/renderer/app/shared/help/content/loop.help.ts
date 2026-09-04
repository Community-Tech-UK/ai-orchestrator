import type { HelpEntry } from '../help-content.types';

/** Loop Mode help, folded into the Orchestration settings tab (no Control Center surface id). */
export const LOOP_MODE_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'Loop Mode',
      body:
        'Loop Mode runs a child CLI toward a goal until a completion gate fires, a cap trips, or you stop it. ' +
        'There is no token cap by default — that is not a 1 million token budget. Caps that exist are iterations (50) and wall time (50 hours).',
    },
    {
      kind: 'list',
      heading: 'Same session vs fresh child',
      items: [
        'Same session (default): one persistent CLI conversation. Occupancy recycle fires on a provider-reported current-window sample (Claude resident, Codex app-server, Copilot server mode). Resume-capable adapters without occupancy recycle every 8 iterations or 100k aggregate tokens. Gemini and Antigravity cannot recycle.',
        'Fresh child: each iteration starts a new process and reloads state from disk. Gemini and Antigravity always behave this way even if the toggle says same-session.',
        'Hybrid is not implemented; picking it would have fallen through to fresh-child, so it is hidden.',
      ],
    },
    {
      kind: 'list',
      heading: 'When the loop stops',
      items: [
        'Review-driven: consecutive clean self-reviews (and optional independent fresh-eyes). Ping-pong review is a different model reviewing each builder done-declaration until both agree.',
        'Gated: verify command, declared-done, optional plan rename. Recipe and stage prompts apply only here.',
        'Review ping-pong is not the tool-loop detector. A TOOL LOOP warning means the child is repeating the same tool calls.',
        'Every tripped cap currently takes one extra wrap-up iteration so the child can write LOOP_TASKS.md and NOTES.md. The HUD labels that turn wrap-up.',
        'Auto-unstick tries a change of approach twice on some CRITICAL progress signals, then the loop follows its terminal policy.',
      ],
    },
    {
      kind: 'list',
      heading: 'State files',
      items: [
        'OUTSTANDING.md holds needs-human items and open questions.',
        'LOOP_TASKS.md is the structured ledger the loop treats as done only on a close transition.',
        'Verify failures in an isolated worktree may be missing node_modules, not a failed test. A red suite that is green when re-run in isolation is not a child defect.',
      ],
    },
  ],
};
