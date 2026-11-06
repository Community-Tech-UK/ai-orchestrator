/**
 * IPC channel for the "what will this change cost?" sentence shown before a model, effort,
 * provider or auto-approve change that restarts a session (Oct-2 T17).
 *
 * Read-only: it describes what the change would do and changes nothing.
 */
export const RUNTIME_CHANGE_PREVIEW_CHANNELS = {
  INSTANCE_RUNTIME_CHANGE_PREVIEW: 'instance:runtime-change-preview',
} as const;
