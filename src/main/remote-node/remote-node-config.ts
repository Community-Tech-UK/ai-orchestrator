export interface RemoteNodeConfig {
  /** Master switch — remote node subsystem is off by default */
  enabled: boolean;
  /** WebSocket server port for worker connections */
  serverPort: number;
  /** Bind address for the WebSocket server */
  serverHost: string;
  /** Shared secret for node authentication (auto-generated if empty) */
  authToken?: string;
  /** Auto-route browser tasks to nodes with browser capability */
  autoOffloadBrowser: boolean;
  /** Auto-route GPU tasks to nodes with GPU */
  autoOffloadGpu: boolean;
  /** Global cap on total remote instances */
  maxRemoteInstances: number;
}

const DEFAULT_CONFIG: RemoteNodeConfig = {
  enabled: false,
  serverPort: 4878,
  serverHost: '127.0.0.1',
  autoOffloadBrowser: true,
  autoOffloadGpu: false,
  maxRemoteInstances: 20,
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
