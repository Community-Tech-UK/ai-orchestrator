/**
 * IPC channels for the learning subsystems: self-improvement (learning outcomes),
 * Specialist agents and A/B experiment management.
 */
export const LEARNING_CHANNELS = {
  // Self-Improvement operations
  LEARNING_RECORD_OUTCOME: 'learning:record-outcome',
  LEARNING_GET_OUTCOME: 'learning:get-outcome',
  LEARNING_GET_RECENT_OUTCOMES: 'learning:get-recent-outcomes',
  LEARNING_GET_EXPERIENCE: 'learning:get-experience',
  LEARNING_GET_ALL_EXPERIENCES: 'learning:get-all-experiences',
  LEARNING_GET_INSIGHTS: 'learning:get-insights',
  LEARNING_GET_PATTERNS: 'learning:get-patterns',
  LEARNING_GET_SUGGESTIONS: 'learning:get-suggestions',
  LEARNING_GET_RECOMMENDATION: 'learning:get-recommendation',
  LEARNING_ENHANCE_PROMPT: 'learning:enhance-prompt',
  LEARNING_GET_STATS: 'learning:get-stats',
  LEARNING_GET_TASK_STATS: 'learning:get-task-stats',
  LEARNING_RATE_OUTCOME: 'learning:rate-outcome',
  LEARNING_CONFIGURE: 'learning:configure',

  // Specialist operations
  SPECIALIST_LIST: 'specialist:list',
  SPECIALIST_LIST_BUILTIN: 'specialist:list-builtin',
  SPECIALIST_LIST_CUSTOM: 'specialist:list-custom',
  SPECIALIST_GET: 'specialist:get',
  SPECIALIST_GET_BY_CATEGORY: 'specialist:get-by-category',
  SPECIALIST_ADD_CUSTOM: 'specialist:add-custom',
  SPECIALIST_UPDATE_CUSTOM: 'specialist:update-custom',
  SPECIALIST_REMOVE_CUSTOM: 'specialist:remove-custom',
  SPECIALIST_RECOMMEND: 'specialist:recommend',
  SPECIALIST_CREATE_INSTANCE: 'specialist:create-instance',
  SPECIALIST_GET_INSTANCE: 'specialist:get-instance',
  SPECIALIST_GET_ACTIVE_INSTANCES: 'specialist:get-active-instances',
  SPECIALIST_UPDATE_STATUS: 'specialist:update-status',
  SPECIALIST_ADD_FINDING: 'specialist:add-finding',
  SPECIALIST_UPDATE_METRICS: 'specialist:update-metrics',
  SPECIALIST_GET_PROMPT_ADDITION: 'specialist:get-prompt-addition',
  SPECIALIST_INSTANCE_CREATED: 'specialist:instance-created',
  SPECIALIST_INSTANCE_STATUS_CHANGED: 'specialist:instance-status-changed',
  SPECIALIST_FINDING_ADDED: 'specialist:finding-added',

  // Correction mining (WS-B8 fail->fix scan into governed 'rule' proposals)
  LEARNING_SCAN_RUN: 'learning-scan:run',
  LEARNING_SCAN_GET_STATUS: 'learning-scan:get-status',

  // A/B Testing operations
  AB_CREATE_EXPERIMENT: 'ab:create-experiment',
  AB_UPDATE_EXPERIMENT: 'ab:update-experiment',
  AB_DELETE_EXPERIMENT: 'ab:delete-experiment',
  AB_START_EXPERIMENT: 'ab:start-experiment',
  AB_PAUSE_EXPERIMENT: 'ab:pause-experiment',
  AB_COMPLETE_EXPERIMENT: 'ab:complete-experiment',
  AB_GET_EXPERIMENT: 'ab:get-experiment',
  AB_LIST_EXPERIMENTS: 'ab:list-experiments',
  AB_GET_VARIANT: 'ab:get-variant',
  AB_RECORD_OUTCOME: 'ab:record-outcome',
  AB_GET_RESULTS: 'ab:get-results',
  AB_GET_WINNER: 'ab:get-winner',
  AB_GET_STATS: 'ab:get-stats',
  AB_CONFIGURE: 'ab:configure',
} as const;
