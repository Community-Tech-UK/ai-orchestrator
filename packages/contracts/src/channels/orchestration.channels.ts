/**
 * IPC channels for orchestration, multi-agent verification, debate, consensus,
 * workflows, review agents, hooks, and skills.
 */
export const ORCHESTRATION_CHANNELS = {
  // Orchestration activity (real-time status updates)
  ORCHESTRATION_ACTIVITY: 'orchestration:activity',
  SUPERVISOR_STATUS: 'supervisor:status',
  SUPERVISOR_METRICS: 'supervisor:metrics',

  // Multi-Agent Verification operations
  VERIFY_START: 'verify:start',
  VERIFY_GET_RESULT: 'verify:get-result',
  VERIFY_GET_ACTIVE: 'verify:get-active',
  VERIFY_CANCEL: 'verify:cancel',
  VERIFY_GET_PERSONALITIES: 'verify:get-personalities',
  VERIFY_CONFIGURE: 'verify:configure',
  VERIFY_STARTED: 'verify:started',
  VERIFY_AGENT_RESPONDED: 'verify:agent-responded',
  VERIFY_COMPLETED: 'verify:completed',

  // Verification operations (Phase 8.3 - alternative naming)
  VERIFICATION_VERIFY_MULTI: 'verification:verify-multi',
  VERIFICATION_START_CLI: 'verification:start-cli',
  VERIFICATION_CANCEL: 'verification:cancel',
  VERIFICATION_GET_ACTIVE: 'verification:get-active',
  VERIFICATION_GET_RESULT: 'verification:get-result',

  // Verification streaming events
  VERIFICATION_AGENT_START: 'verification:agent-start',
  VERIFICATION_AGENT_STREAM: 'verification:agent-stream',
  VERIFICATION_AGENT_COMPLETE: 'verification:agent-complete',
  VERIFICATION_AGENT_ERROR: 'verification:agent-error',
  VERIFICATION_ROUND_PROGRESS: 'verification:round-progress',
  VERIFICATION_CONSENSUS_UPDATE: 'verification:consensus-update',
  VERIFICATION_COMPLETE: 'verification:complete',
  VERIFICATION_ERROR: 'verification:error',

  // Verification event forwarding (main -> renderer)
  VERIFICATION_EVENT_STARTED: 'verification:event:started',
  VERIFICATION_EVENT_PROGRESS: 'verification:event:progress',
  VERIFICATION_EVENT_COMPLETED: 'verification:event:completed',
  VERIFICATION_EVENT_ERROR: 'verification:event:error',

  // Debate operations
  DEBATE_START: 'debate:start',
  DEBATE_GET_RESULT: 'debate:get-result',
  DEBATE_GET_ACTIVE: 'debate:get-active',
  DEBATE_CANCEL: 'debate:cancel',
  DEBATE_GET_STATS: 'debate:get-stats',
  DEBATE_PAUSE: 'debate:pause',
  DEBATE_RESUME: 'debate:resume',
  DEBATE_STOP: 'debate:stop',
  DEBATE_INTERVENE: 'debate:intervene',
  DEBATE_EVENT: 'debate:event',

  // Debate event forwarding (main -> renderer)
  DEBATE_EVENT_STARTED: 'debate:event:started',
  DEBATE_EVENT_ROUND_COMPLETE: 'debate:event:round-complete',
  DEBATE_EVENT_COMPLETED: 'debate:event:completed',
  DEBATE_EVENT_ERROR: 'debate:event:error',
  DEBATE_EVENT_PAUSED: 'debate:event:paused',
  DEBATE_EVENT_RESUMED: 'debate:event:resumed',

  // Consensus operations
  CONSENSUS_QUERY: 'consensus:query',
  CONSENSUS_ABORT: 'consensus:abort',
  CONSENSUS_GET_ACTIVE: 'consensus:get-active',

  // Cascade Supervision operations
  SUPERVISION_CREATE_TREE: 'supervision:create-tree',
  SUPERVISION_ADD_WORKER: 'supervision:add-worker',
  SUPERVISION_START_WORKER: 'supervision:start-worker',
  SUPERVISION_STOP_WORKER: 'supervision:stop-worker',
  SUPERVISION_HANDLE_FAILURE: 'supervision:handle-failure',
  SUPERVISION_GET_TREE: 'supervision:get-tree',
  SUPERVISION_GET_HEALTH: 'supervision:get-health',
  SUPERVISION_GET_HIERARCHY: 'supervision:get-hierarchy',
  SUPERVISION_GET_ALL_REGISTRATIONS: 'supervision:get-all-registrations',
  SUPERVISION_EXHAUSTED: 'supervision:exhausted',
  SUPERVISION_HEALTH_CHANGED: 'supervision:health-changed',
  SUPERVISION_HEALTH_GLOBAL: 'supervision:health-global',
  SUPERVISION_TREE_UPDATED: 'supervision:tree-updated',
  SUPERVISION_WORKER_FAILED: 'supervision:worker-failed',
  SUPERVISION_WORKER_RESTARTED: 'supervision:worker-restarted',
  SUPERVISION_CIRCUIT_BREAKER_CHANGED: 'supervision:circuit-breaker-changed',

  // Workflow operations
  WORKFLOW_LIST_TEMPLATES: 'workflow:list-templates',
  WORKFLOW_GET_TEMPLATE: 'workflow:get-template',
  WORKFLOW_START: 'workflow:start',
  WORKFLOW_GET_EXECUTION: 'workflow:get-execution',
  WORKFLOW_GET_BY_INSTANCE: 'workflow:get-by-instance',
  WORKFLOW_COMPLETE_PHASE: 'workflow:complete-phase',
  WORKFLOW_SATISFY_GATE: 'workflow:satisfy-gate',
  WORKFLOW_SKIP_PHASE: 'workflow:skip-phase',
  WORKFLOW_CANCEL: 'workflow:cancel',
  WORKFLOW_GET_PROMPT_ADDITION: 'workflow:get-prompt-addition',
  WORKFLOW_STARTED: 'workflow:started',
  WORKFLOW_COMPLETED: 'workflow:completed',
  WORKFLOW_PHASE_CHANGED: 'workflow:phase-changed',
  WORKFLOW_GATE_PENDING: 'workflow:gate-pending',

  // Review agent operations
  REVIEW_LIST_AGENTS: 'review:list-agents',
  REVIEW_GET_AGENT: 'review:get-agent',
  REVIEW_START_SESSION: 'review:start-session',
  REVIEW_GET_SESSION: 'review:get-session',
  REVIEW_GET_ISSUES: 'review:get-issues',
  REVIEW_ACKNOWLEDGE_ISSUE: 'review:acknowledge-issue',
  REVIEW_SESSION_STARTED: 'review:session-started',
  REVIEW_SESSION_COMPLETED: 'review:session-completed',

  // Cross-Model Review
  CROSS_MODEL_REVIEW_RESULT: 'cross-model-review:result',
  CROSS_MODEL_REVIEW_STARTED: 'cross-model-review:started',
  CROSS_MODEL_REVIEW_ALL_UNAVAILABLE: 'cross-model-review:all-unavailable',
  CROSS_MODEL_REVIEW_STATUS: 'cross-model-review:status',
  CROSS_MODEL_REVIEW_DISMISS: 'cross-model-review:dismiss',
  CROSS_MODEL_REVIEW_ACTION: 'cross-model-review:action',

  // Hook operations
  HOOKS_LIST: 'hooks:list',
  HOOKS_GET: 'hooks:get',
  HOOKS_CREATE: 'hooks:create',
  HOOKS_UPDATE: 'hooks:update',
  HOOKS_DELETE: 'hooks:delete',
  HOOKS_EVALUATE: 'hooks:evaluate',
  HOOKS_IMPORT: 'hooks:import',
  HOOKS_EXPORT: 'hooks:export',
  HOOK_APPROVALS_LIST: 'hooks:approvals:list',
  HOOK_APPROVALS_UPDATE: 'hooks:approvals:update',
  HOOK_APPROVALS_CLEAR: 'hooks:approvals:clear',
  HOOKS_TRIGGERED: 'hooks:triggered',

  // Skill operations
  SKILLS_DISCOVER: 'skills:discover',
  SKILLS_LIST: 'skills:list',
  SKILLS_GET: 'skills:get',
  SKILLS_LOAD: 'skills:load',
  SKILLS_UNLOAD: 'skills:unload',
  SKILLS_LOAD_REFERENCE: 'skills:load-reference',
  SKILLS_LOAD_EXAMPLE: 'skills:load-example',
  SKILLS_MATCH: 'skills:match',
  SKILLS_GET_MEMORY: 'skills:get-memory',

  // User action requests (orchestrator -> user)
  USER_ACTION_REQUEST: 'user-action:request',
  USER_ACTION_RESPOND: 'user-action:respond',
  USER_ACTION_LIST: 'user-action:list',
  USER_ACTION_LIST_FOR_INSTANCE: 'user-action:list-for-instance',
  USER_ACTION_RESPONSE: 'user-action-response',

  // Plan mode operations
  PLAN_MODE_ENTER: 'plan:enter',
  PLAN_MODE_EXIT: 'plan:exit',
  PLAN_MODE_APPROVE: 'plan:approve',
  PLAN_MODE_UPDATE: 'plan:update',
  PLAN_MODE_GET_STATE: 'plan:get-state',

  // LLM Service operations (streaming)
  LLM_SUMMARIZE: 'llm:summarize',
  LLM_SUMMARIZE_STREAM: 'llm:summarize-stream',
  LLM_SUBQUERY: 'llm:subquery',
  LLM_SUBQUERY_STREAM: 'llm:subquery-stream',
  LLM_CANCEL_STREAM: 'llm:cancel-stream',
  LLM_STREAM_CHUNK: 'llm:stream-chunk',
  LLM_COUNT_TOKENS: 'llm:count-tokens',
  LLM_TRUNCATE_TOKENS: 'llm:truncate-tokens',
  LLM_GET_CONFIG: 'llm:get-config',
  LLM_SET_CONFIG: 'llm:set-config',
  LLM_GET_STATUS: 'llm:get-status',

  // Command operations
  COMMAND_LIST: 'command:list',
  COMMAND_EXECUTE: 'command:execute',
  COMMAND_CREATE: 'command:create',
  COMMAND_UPDATE: 'command:update',
  COMMAND_DELETE: 'command:delete',

  // Menu events (renderer-bound)
  MENU_NEW_INSTANCE: 'menu:new-instance',
  MENU_OPEN_SETTINGS: 'menu:open-settings',
} as const;
