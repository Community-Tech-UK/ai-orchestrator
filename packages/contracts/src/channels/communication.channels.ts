/**
 * IPC channels for inter-instance communication, channel management,
 * reaction engine, remote observer, remote nodes, and remote filesystem.
 */
export const COMMUNICATION_CHANNELS = {
  // Cross-instance communication
  COMM_REQUEST_TOKEN: 'comm:request-token',
  COMM_SEND_MESSAGE: 'comm:send-message',
  COMM_SUBSCRIBE: 'comm:subscribe',
  COMM_CONTROL: 'comm:control-instance',
  COMM_CREATE_BRIDGE: 'comm:create-bridge',
  COMM_GET_MESSAGES: 'comm:get-messages',
  COMM_GET_BRIDGES: 'comm:get-bridges',
  COMM_DELETE_BRIDGE: 'comm:delete-bridge',

  // Channel management (request/response)
  CHANNEL_CONNECT: 'channel:connect',
  CHANNEL_DISCONNECT: 'channel:disconnect',
  CHANNEL_GET_STATUS: 'channel:get-status',
  CHANNEL_GET_MESSAGES: 'channel:get-messages',
  CHANNEL_SEND_MESSAGE: 'channel:send-message',
  CHANNEL_PAIR_SENDER: 'channel:pair-sender',
  CHANNEL_SET_ACCESS_POLICY: 'channel:set-access-policy',
  CHANNEL_GET_ACCESS_POLICY: 'channel:get-access-policy',

  // Channel push events (main -> renderer)
  CHANNEL_STATUS_CHANGED: 'channel:status-changed',
  CHANNEL_MESSAGE_RECEIVED: 'channel:message-received',
  CHANNEL_RESPONSE_SENT: 'channel:response-sent',
  CHANNEL_ERROR: 'channel:error',

  // Reaction Engine
  REACTION_GET_CONFIG: 'reaction:get-config',
  REACTION_UPDATE_CONFIG: 'reaction:update-config',
  REACTION_TRACK_INSTANCE: 'reaction:track-instance',
  REACTION_UNTRACK_INSTANCE: 'reaction:untrack-instance',
  REACTION_GET_TRACKED: 'reaction:get-tracked',
  REACTION_GET_STATE: 'reaction:get-state',
  REACTION_EVENT: 'reaction:event',
  REACTION_ESCALATED: 'reaction:escalated',

  // Remote observer / read-only access
  REMOTE_OBSERVER_GET_STATUS: 'remote-observer:get-status',
  REMOTE_OBSERVER_START: 'remote-observer:start',
  REMOTE_OBSERVER_STOP: 'remote-observer:stop',
  REMOTE_OBSERVER_ROTATE_TOKEN: 'remote-observer:rotate-token',

  // Remote nodes
  REMOTE_NODE_LIST: 'remote-node:list',
  REMOTE_NODE_GET: 'remote-node:get',
  REMOTE_NODE_START_SERVER: 'remote-node:start-server',
  REMOTE_NODE_STOP_SERVER: 'remote-node:stop-server',
  REMOTE_NODE_EVENT: 'remote-node:event',
  REMOTE_NODE_NODES_CHANGED: 'remote-node:nodes-changed',
  REMOTE_NODE_REGENERATE_TOKEN: 'remote-node:regenerate-token',
  REMOTE_NODE_SET_TOKEN: 'remote-node:set-token',
  REMOTE_NODE_REVOKE: 'remote-node:revoke',
  REMOTE_NODE_GET_SERVER_STATUS: 'remote-node:get-server-status',
  REMOTE_NODE_SERVICE_STATUS: 'remote-node:service:status',
  REMOTE_NODE_SERVICE_RESTART: 'remote-node:service:restart',
  REMOTE_NODE_SERVICE_STOP: 'remote-node:service:stop',
  REMOTE_NODE_SERVICE_UNINSTALL: 'remote-node:service:uninstall',

  // Remote Filesystem operations
  REMOTE_FS_READ_DIR: 'remote-fs:read-dir',
  REMOTE_FS_STAT: 'remote-fs:stat',
  REMOTE_FS_SEARCH: 'remote-fs:search',
  REMOTE_FS_WATCH: 'remote-fs:watch',
  REMOTE_FS_UNWATCH: 'remote-fs:unwatch',

  // File transfer (coordinator <-> remote node)
  REMOTE_FS_COPY_TO_REMOTE: 'remote-fs:copy-to-remote',
  REMOTE_FS_COPY_FROM_REMOTE: 'remote-fs:copy-from-remote',
  REMOTE_FS_READ_FILE: 'remote-fs:read-file',
  REMOTE_FS_WRITE_FILE: 'remote-fs:write-file',

  // Directory sync (rsync-style)
  REMOTE_FS_SYNC_START: 'remote-fs:sync-start',
  REMOTE_FS_SYNC_PROGRESS: 'remote-fs:sync-progress',
  REMOTE_FS_SYNC_CANCEL: 'remote-fs:sync-cancel',
  REMOTE_FS_SYNC_DIFF: 'remote-fs:sync-diff'
} as const;
