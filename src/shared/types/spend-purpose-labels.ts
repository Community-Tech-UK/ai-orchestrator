/** Display names for stable cost-log purpose keys, shared without importing main-process code. */
export const SPEND_PURPOSE_LABELS: Readonly<Record<string, string>> = {
  chat: 'Chat', child: 'Child sessions', 'plan-queue': 'Plan queue',
  'repo-job': 'Repo jobs', 'remote-node': 'Remote machines', 'quick-ask': 'Quick ask',
  review: 'Reviews', automation: 'Automations', channel: 'Messages',
  helper: 'Helpers', loop: 'Loops', verify: 'Verification', debate: 'Debates',
  workflow: 'Workflows', 'branch-select': 'Branch selection',
  'cross-model-review': 'Cross-model reviews', 'fresh-eyes-review': 'Fresh eyes reviews',
  'review-cli': 'CLI reviews', consensus: 'Consensus',
  'multi-verify-synthesis': 'Verification synthesis', council: 'Councils',
  compare: 'Comparisons', 'magic-prompt': 'Magic prompts',
  'cli-verification': 'CLI verification', subagent: 'Subagents', unknown: 'Unknown',
};

export function spendPurposeLabel(key: string): string {
  return Object.prototype.hasOwnProperty.call(SPEND_PURPOSE_LABELS, key)
    ? SPEND_PURPOSE_LABELS[key]
    : key.replace(/[-_:]+/g, ' ').replace(/^./, first => first.toUpperCase());
}
