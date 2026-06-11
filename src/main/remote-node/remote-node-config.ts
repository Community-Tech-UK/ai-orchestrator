export interface RemoteNodeConfig {
  /** Master switch — remote node subsystem is off by default */
  enabled: boolean;
  /** WebSocket server port for worker connections */
  serverPort: number;
  /** Bind address for the WebSocket server */
  serverHost: string;
  /** Auto-route browser tasks to nodes with browser capability */
  autoOffloadBrowser: boolean;
  /** Auto-route Android tasks to nodes with Android capability */
  autoOffloadAndroid: boolean;
  /** Auto-route GPU tasks to nodes with GPU */
  autoOffloadGpu: boolean;
  /** Global cap on total remote instances */
  maxRemoteInstances: number;
  /** Logical namespace for grouping nodes */
  namespace: string;
  /** Certificate source; auto mode is self-signed and not worker-repairable without a trust path. */
  tlsMode?: 'auto' | 'custom';
  /** Path to TLS certificate file (PEM). If set with tlsKeyPath, enables WSS. */
  tlsCertPath?: string;
  /** Path to TLS private key file (PEM). */
  tlsKeyPath?: string;
  /** Path to CA certificate for client cert verification (mutual TLS). */
  tlsCaPath?: string;
}

const DEFAULT_CONFIG: RemoteNodeConfig = {
  enabled: false,
  serverPort: 4878,
  serverHost: '127.0.0.1',
  autoOffloadBrowser: true,
  autoOffloadAndroid: true,
  autoOffloadGpu: false,
  maxRemoteInstances: 20,
  namespace: 'default',
  tlsMode: 'auto',
};

let currentConfig: RemoteNodeConfig = { ...DEFAULT_CONFIG };

export function getRemoteNodeConfig(): RemoteNodeConfig {
  return currentConfig;
}

export function updateRemoteNodeConfig(partial: Partial<RemoteNodeConfig>): void {
  currentConfig = { ...currentConfig, ...partial };
}

/** Reset to defaults (for testing) */
export function resetRemoteNodeConfig(): void {
  currentConfig = { ...DEFAULT_CONFIG };
}

/** Hydrate the live config from persisted AppSettings. Call once on startup. */
export function hydrateRemoteNodeConfig(settings: import('../../shared/types/settings.types').AppSettings): void {
  updateRemoteNodeConfig({
    enabled: settings.remoteNodesEnabled,
    serverPort: settings.remoteNodesServerPort,
    serverHost: settings.remoteNodesServerHost,
    autoOffloadBrowser: settings.remoteNodesAutoOffloadBrowser,
    autoOffloadAndroid: settings.remoteNodesAutoOffloadAndroid,
    autoOffloadGpu: settings.remoteNodesAutoOffloadGpu,
    namespace: settings.remoteNodesNamespace,
    tlsMode: settings.remoteNodesTlsMode,
    tlsCertPath: settings.remoteNodesTlsCertPath || undefined,
    tlsKeyPath: settings.remoteNodesTlsKeyPath || undefined,
  });
}
