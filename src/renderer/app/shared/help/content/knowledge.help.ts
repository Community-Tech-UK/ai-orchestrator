/**
 * Help & tips content - Knowledge group surfaces.
 * Grounded in the actual controls each page exposes; keep in sync when the
 * pages gain or lose functionality.
 */

import type { HelpEntry } from '../help-content.types';

export const CHAT_SEARCH_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Search all stored sessions and live instances by title, message content, or project path. Results show the most recent matches first with snippet previews and timestamps.',
    },
    {
      kind: 'steps',
      heading: 'How to search',
      items: [
        'Type a keyword: project name, conversation snippet, or directory path.',
        'Results update as you type.',
        'Click a result to restore the session or switch to a live instance.',
        'Press Escape to clear the search.',
      ],
    },
    {
      kind: 'list',
      heading: 'What gets searched',
      items: [
        'Session display names and first/last user messages.',
        'Live instance names and working directories.',
        'Project paths derived from the working directory.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Results are capped',
      body: 'Only the 50 most recent matches show. Refine your query to reach older sessions.',
    },
  ],
};

export const RLM_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'The Learning Database stores retrieval-based learning memory. Create context stores and sessions, query them by type, and inspect learned patterns and strategy suggestions in the side panel.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Select or create a store from the toolbar dropdown.',
        'Start a session once a store is active.',
        'Enter a query, pick a query type, and execute.',
        'Browse results in the main panel; inspect sections as needed.',
      ],
    },
    {
      kind: 'list',
      heading: 'Learned patterns show',
      items: [
        'Pattern type, such as prompt structure or context selection.',
        'Effectiveness score as a percentage.',
        'Sample size: how many times the pattern was used.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Get strategy suggestions',
      body: 'Describe a task in the Strategy Suggestions box and click Suggest to see a recommended agent, model, and confidence with reasoning.',
    },
  ],
};

export const TRAINING_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Track training outcomes, visualise reward trends, discover top strategies, and manage training data through import, export, and configuration.',
    },
    {
      kind: 'steps',
      heading: 'How to record and view',
      items: [
        'Fill the Record Outcome form (task ID, prompt, and response are required).',
        'Click Record to add the outcome; the dashboard refreshes automatically.',
        'Check the side panel for the trend line, top strategies, and statistics.',
        'Use Export JSON to back up, or paste JSON into Import to restore.',
      ],
    },
    {
      kind: 'list',
      heading: 'Dashboard tabs',
      items: [
        'Overview: reward trend and headline statistics.',
        'Strategies: top-performing strategies ranked by reward.',
        'Patterns: recurring behaviours the trainer has spotted.',
        'Insights: derived observations about what works.',
        'Config: tuning values such as group size and learning rate.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Reward values matter',
      body: 'Rewards outside 0 to 1 are clamped. An outcome counts as a success when its reward is 0.6 or higher.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Watch the trend',
      body: 'The trend panel shows whether reward is improving over time. Raise the strategy limit to see more top performers.',
    },
  ],
};

export const MEMORY_BROWSER_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Query the memory system to retrieve stored entries, view learned patterns and session history, and manage workflow memory.',
    },
    {
      kind: 'steps',
      heading: 'How to retrieve',
      items: [
        'Enter a retrieve query (for example "auth bug fix context") and optional task ID.',
        'Adjust the Pattern Min Success threshold if needed, then click Retrieve.',
        'Browse retrieved entries in the main panel.',
        'Select an entry to delete it or follow its links.',
      ],
    },
    {
      kind: 'list',
      heading: 'Side panel shows',
      items: [
        'Memory stats: entries, tokens, average relevance, cache hit rate.',
        'Learned patterns with success rate and usage count.',
        'Session history with recent outcomes.',
        'Workflow memory with success rates and step counts.',
      ],
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Pattern Min Success',
          value: '0.5 (default)',
          why: 'Raise it to see only high-confidence patterns; lower it to explore weak signals.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Deleting entries is permanent',
      body: 'Removed memory entries cannot be restored and may weaken future retrievals that relied on them.',
    },
  ],
};

export const MEMORY_STATS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Read-only statistics on memory storage: entries by type, token usage, operation counts, eviction activity, and cross-session retention.',
    },
    {
      kind: 'list',
      heading: 'Key metrics',
      items: [
        'Total entries: count of all stored memory records.',
        'Tokens used: consumption against the limit, split short-term and long-term.',
        'Operations: adds, updates, deletes, and no-ops.',
        'Evictions: total and recent, broken down by reason.',
        'Retention: cross-session retention rate and average memory lifespan.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Watch token pressure',
      body: 'If tokens approach the limit, evictions increase and useful memories may be lost. Rising eviction counts are the early warning.',
    },
  ],
};

export const OBSERVATIONS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Shows agent observations (auto-captured events), reflections (structured analysis with confidence scores), and recognised patterns.',
    },
    {
      kind: 'steps',
      heading: 'How to explore',
      items: [
        'Click an observation to expand its full content.',
        'Review reflections in the centre column; each shows evidence and confidence.',
        'Check the patterns panel for what the system has recognised.',
        'Click Refresh to reload all three panels.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Force a reflection cycle',
      body: 'Force Reflect in the Reflection Timeline header triggers manual reflection on current observations.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Reading confidence bars',
      body: 'Green means high confidence (70%+), yellow moderate, red low. "Unavailable" panels mean the backend service is not running, not an error.',
    },
  ],
};

export const KNOWLEDGE_GRAPH_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Organises project entities, facts, code symbols, and codebase intelligence. Tabs cover graph queries, wake context setup, and conversation import.',
    },
    {
      kind: 'steps',
      heading: 'How to query',
      items: [
        'Enter an entity name and click Search to find related facts.',
        'Or enter a predicate (for example uses_database) to browse relationship pairs.',
        'Click Evidence to inspect source locations and metadata.',
        'Switch projects with the dropdown in the side panel.',
      ],
    },
    {
      kind: 'steps',
      heading: 'Adding facts',
      items: [
        'Click Add Fact below the facts table.',
        'Fill Subject, Predicate, Object, and optional confidence and date.',
        'Click Add Fact to commit; use Invalidate to expire a wrong fact.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Codebase mining',
      body: 'Browse to a directory and click Mine to extract facts, symbols, and hints. Pause or resume mining at any time.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Excluding is sticky',
      body: 'An excluded directory stays out of mining until you manually reset its status in the knowledge database.',
    },
  ],
};
