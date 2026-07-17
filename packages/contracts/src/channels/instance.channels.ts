/**
 * IPC channels for instance lifecycle: creation, I/O, hibernation, and context compaction.
 */
export const INSTANCE_CHANNELS = {
  // Instance management
  INSTANCE_CREATE: 'instance:create',
  INSTANCE_CREATE_WITH_MESSAGE: 'instance:create-with-message',
  INSTANCE_TERMINATE: 'instance:terminate',
  INSTANCE_TERMINATE_ALL: 'instance:terminate-all',
  INSTANCE_RESTART: 'instance:restart',
  INSTANCE_RESTART_FRESH: 'instance:restart-fresh',
  INSTANCE_RENAME: 'instance:rename',
  INSTANCE_CHANGE_AGENT_MODE: 'instance:change-agent-mode',
  INSTANCE_TOGGLE_YOLO_MODE: 'instance:toggle-yolo-mode',
  /** Main → renderer: yolo mode changed, or a change was queued/cancelled while busy. */
  INSTANCE_YOLO_TOGGLED: 'instance:yolo-toggled',
  INSTANCE_TOGGLE_FAST_MODE: 'instance:toggle-fast-mode',
  /** Main → renderer: fast mode changed (user toggle or provider auto-revert). */
  INSTANCE_FAST_TOGGLED: 'instance:fast-toggled',
  INSTANCE_CHANGE_MODEL: 'instance:change-model',
  INSTANCE_SEND_INPUT: 'instance:send-input',
  INSTANCE_STEER_INPUT: 'instance:steer-input',
  INSTANCE_INTERRUPT: 'instance:interrupt',
  /** Resume a session parked on a provider limit immediately (skip the wait). */
  INSTANCE_PROVIDER_LIMIT_RESUME_NOW: 'instance:provider-limit-resume-now',
  /** Cancel a provider-limit park so the session won't auto-resume. */
  INSTANCE_PROVIDER_LIMIT_CANCEL: 'instance:provider-limit-cancel',
  INSTANCE_FAILOVER_NOW: 'instance:failover-now',
  INSTANCE_HARDENED_ALLOW_PATH: 'instance:hardened-allow-path',
  INSTANCE_STATE_UPDATE: 'instance:state-update',
  INSTANCE_BATCH_UPDATE: 'instance:batch-update',
  INSTANCE_CREATED: 'instance:created',
  INSTANCE_REMOVED: 'instance:removed',
  INSTANCE_LIST: 'instance:list',
  INSTANCE_LOAD_OLDER_MESSAGES: 'instance:load-older-messages',
  INSTANCE_GET_PROMPT_INDEX: 'instance:get-prompt-index',

  // Hibernation lifecycle
  INSTANCE_HIBERNATE: 'instance:hibernate',
  INSTANCE_HIBERNATED: 'instance:hibernated',
  INSTANCE_WAKE: 'instance:wake',
  INSTANCE_WAKING: 'instance:waking',
  INSTANCE_TRANSCRIPT_CHUNK: 'instance:transcript-chunk',

  // Context compaction
  INSTANCE_COMPACT: 'instance:compact',
  INSTANCE_RECOVER_COMPACTION_CONTEXT: 'instance:recover-compaction-context',
  INSTANCE_COMPACT_STATUS: 'instance:compact-status',
  CONTEXT_WARNING: 'context:warning',

  // Input required events (CLI permission prompts, etc.)
  INPUT_REQUIRED: 'instance:input-required',
  INPUT_REQUIRED_RESPOND: 'instance:input-required-respond',

  // Queue persistence (Pause on VPN feature)
  INSTANCE_QUEUE_SAVE: 'instance:queue-save',
  INSTANCE_QUEUE_LOAD_ALL: 'instance:queue-load-all',
  INSTANCE_QUEUE_INITIAL_PROMPT: 'instance:queue-initial-prompt',
} as const;
