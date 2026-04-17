import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createCommunicationDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS
) {
  return {
    // ============================================
    // Remote observer / read-only access
    // ============================================

    remoteObserverGetStatus: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_OBSERVER_GET_STATUS);
    },

    remoteObserverStart: (payload?: {
      host?: string;
      port?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_OBSERVER_START, payload || {});
    },

    remoteObserverStop: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_OBSERVER_STOP);
    },

    remoteObserverRotateToken: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_OBSERVER_ROTATE_TOKEN);
    },

    // ============================================
    // Remote Nodes
    // ============================================

    remoteNodeList: (): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_LIST),

    remoteNodeGet: (nodeId: string): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_GET, { nodeId }),

    remoteNodeStartServer: (config?: {
      port?: number;
      host?: string;
    }): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_START_SERVER, config),

    remoteNodeStopServer: (): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_STOP_SERVER),

    remoteNodeRegenerateToken: (): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_REGENERATE_TOKEN),

    remoteNodeSetToken: (token: string): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_SET_TOKEN, { token }),

    remoteNodeRevokeNode: (nodeId: string): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_REVOKE, { nodeId }),

    remoteNodeGetServerStatus: (): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_GET_SERVER_STATUS),

    remoteNodeServiceStatus: (nodeId: string): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_SERVICE_STATUS, { nodeId }),

    remoteNodeServiceRestart: (nodeId: string): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_SERVICE_RESTART, { nodeId }),

    remoteNodeServiceStop: (nodeId: string): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_SERVICE_STOP, { nodeId }),

    remoteNodeServiceUninstall: (nodeId: string): Promise<unknown> =>
      ipcRenderer.invoke(ch.REMOTE_NODE_SERVICE_UNINSTALL, { nodeId }),

    onRemoteNodeEvent: (callback: (event: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.REMOTE_NODE_EVENT, handler);
      return () => ipcRenderer.removeListener(ch.REMOTE_NODE_EVENT, handler);
    },

    onRemoteNodeNodesChanged: (
      callback: (nodes: unknown) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.REMOTE_NODE_NODES_CHANGED, handler);
      return () =>
        ipcRenderer.removeListener(ch.REMOTE_NODE_NODES_CHANGED, handler);
    },

    // ============================================
    // File Transfer (coordinator <-> remote node)
    // ============================================

    remoteNodeCopyToRemote: (payload: {
      nodeId: string;
      localPath: string;
      remotePath: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.REMOTE_FS_COPY_TO_REMOTE, payload),

    remoteNodeCopyFromRemote: (payload: {
      nodeId: string;
      remotePath: string;
      localPath: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.REMOTE_FS_COPY_FROM_REMOTE, payload),

    remoteNodeReadFile: (payload: {
      nodeId: string;
      path: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.REMOTE_FS_READ_FILE, payload),

    remoteNodeWriteFile: (payload: {
      nodeId: string;
      path: string;
      data: string;
      mkdirp?: boolean;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.REMOTE_FS_WRITE_FILE, payload),

    // ============================================
    // Directory Sync (rsync-style)
    // ============================================

    remoteNodeSyncStart: (payload: {
      sourceNodeId: string;
      sourcePath: string;
      targetNodeId: string;
      targetPath: string;
      deleteExtraneous?: boolean;
      exclude?: string[];
      dryRun?: boolean;
      blockSize?: number;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.REMOTE_FS_SYNC_START, payload),

    remoteNodeSyncProgress: (payload: {
      jobId: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.REMOTE_FS_SYNC_PROGRESS, payload),

    remoteNodeSyncCancel: (payload: { jobId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.REMOTE_FS_SYNC_CANCEL, payload),

    remoteNodeSyncDiff: (payload: {
      sourceNodeId: string;
      sourcePath: string;
      targetNodeId: string;
      targetPath: string;
      exclude?: string[];
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.REMOTE_FS_SYNC_DIFF, payload),

    // ============================================
    // Cross-Instance Communication
    // ============================================

    commCreateBridge: (payload: {
      name: string;
      sourceInstanceId: string;
      targetInstanceId: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COMM_CREATE_BRIDGE, payload),

    commDeleteBridge: (payload: { bridgeId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COMM_DELETE_BRIDGE, payload),

    commGetBridges: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COMM_GET_BRIDGES),

    commSendMessage: (payload: {
      bridgeId: string;
      fromInstanceId: string;
      content: string;
      metadata?: Record<string, unknown>;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COMM_SEND_MESSAGE, payload),

    commGetMessages: (payload: {
      bridgeId: string;
      limit?: number;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COMM_GET_MESSAGES, payload),

    commSubscribe: (payload: {
      instanceId: string;
      bridgeId: string;
    }): Promise<IpcResponse> => ipcRenderer.invoke(ch.COMM_SUBSCRIBE, payload),

    commRequestToken: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.COMM_REQUEST_TOKEN),

    // ============================================
    // Channels (Discord/WhatsApp)
    // ============================================

    channelConnect: (payload: {
      platform: string;
      token?: string;
    }): Promise<IpcResponse> => ipcRenderer.invoke(ch.CHANNEL_CONNECT, payload),

    channelDisconnect: (payload: { platform: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHANNEL_DISCONNECT, payload),

    channelGetStatus: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHANNEL_GET_STATUS),

    channelGetMessages: (payload: {
      platform: string;
      chatId: string;
      limit?: number;
      before?: number;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHANNEL_GET_MESSAGES, payload),

    channelSendMessage: (payload: {
      platform: string;
      chatId: string;
      content: string;
      replyTo?: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHANNEL_SEND_MESSAGE, payload),

    channelPairSender: (payload: {
      platform: string;
      code: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHANNEL_PAIR_SENDER, payload),

    channelSetAccessPolicy: (payload: {
      platform: string;
      mode: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHANNEL_SET_ACCESS_POLICY, payload),

    channelGetAccessPolicy: (payload: {
      platform: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CHANNEL_GET_ACCESS_POLICY, payload),

    // Channel push event listeners
    onChannelStatusChanged: (
      callback: (data: unknown) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.CHANNEL_STATUS_CHANGED, handler);
      return () =>
        ipcRenderer.removeListener(ch.CHANNEL_STATUS_CHANGED, handler);
    },

    onChannelMessageReceived: (
      callback: (data: unknown) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.CHANNEL_MESSAGE_RECEIVED, handler);
      return () =>
        ipcRenderer.removeListener(ch.CHANNEL_MESSAGE_RECEIVED, handler);
    },

    onChannelResponseSent: (
      callback: (data: unknown) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.CHANNEL_RESPONSE_SENT, handler);
      return () =>
        ipcRenderer.removeListener(ch.CHANNEL_RESPONSE_SENT, handler);
    },

    onChannelError: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.CHANNEL_ERROR, handler);
      return () => ipcRenderer.removeListener(ch.CHANNEL_ERROR, handler);
    },

    // ============================================
    // Remote Filesystem
    // ============================================

    remoteFsReadDirectory: (
      nodeId: string,
      path: string,
      options?: {
        depth?: number;
        includeHidden?: boolean;
        cursor?: string;
        limit?: number;
      }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_FS_READ_DIR, {
        nodeId,
        path,
        ...options
      });
    },

    remoteFsStat: (nodeId: string, path: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_FS_STAT, { nodeId, path });
    },

    remoteFsSearch: (
      nodeId: string,
      query: string,
      maxResults?: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_FS_SEARCH, {
        nodeId,
        query,
        maxResults
      });
    },

    remoteFsWatch: (
      nodeId: string,
      path: string,
      recursive?: boolean
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_FS_WATCH, {
        nodeId,
        path,
        recursive
      });
    },

    remoteFsUnwatch: (
      nodeId: string,
      watchId: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_FS_UNWATCH, { nodeId, watchId });
    }
  };
}
