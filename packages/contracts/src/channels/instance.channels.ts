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
  INSTANCE_CHANGE_MODEL: 'instance:change-model',
  INSTANCE_SEND_INPUT: 'instance:send-input',
  INSTANCE_INTERRUPT: 'instance:interrupt',
  INSTANCE_STATE_UPDATE: 'instance:state-update',
  INSTANCE_BATCH_UPDATE: 'instance:batch-update',
  INSTANCE_CREATED: 'instance:created',
  INSTANCE_REMOVED: 'instance:removed',
  INSTANCE_LIST: 'instance:list',
  INSTANCE_LOAD_OLDER_MESSAGES: 'instance:load-older-messages',

  // Hibernation lifecycle
  INSTANCE_HIBERNATE: 'instance:hibernate',
  INSTANCE_HIBERNATED: 'instance:hibernated',
  INSTANCE_WAKE: 'instance:wake',
  INSTANCE_WAKING: 'instance:waking',
  INSTANCE_TRANSCRIPT_CHUNK: 'instance:transcript-chunk',

  // Context compaction
  INSTANCE_COMPACT: 'instance:compact',
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
