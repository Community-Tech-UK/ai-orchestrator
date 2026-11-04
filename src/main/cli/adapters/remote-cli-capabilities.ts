import type { CliType } from '../cli-detection';
import type { AdapterRuntimeCapabilities } from './base-cli-adapter';

/** Capabilities of the provider process hosted by a remote worker. */
export function remoteCliCapabilities(cliType: CliType): AdapterRuntimeCapabilities {
  switch (cliType) {
    case 'claude':
      return {
        supportsResume: true,
        supportsForkSession: true,
        // Remote proxies to a Claude CLI on the worker node, which runs in
        // headless `--input-format stream-json` mode. Slash commands are not
        // intercepted in that mode — there's no programmatic compaction hook
        // we can call. Mirror the local Claude adapter: no native hook, but
        // the remote Claude self-manages its own internal auto-compaction.
        supportsNativeCompaction: false,
        supportsPermissionPrompts: true,
        supportsDeferPermission: false, // Remote doesn't run local hooks
        selfManagedAutoCompaction: true,
      };
    case 'opencode':
      return {
        supportsResume: true,
        // Remote source-clone RPC is not available; preserve snapshot replay.
        supportsForkSession: false,
        supportsNativeCompaction: false,
        supportsPermissionPrompts: true,
        supportsDeferPermission: false,
        selfManagedAutoCompaction: true,
      };
    case 'codex':
      return {
        supportsResume: true,
        supportsForkSession: false,
        supportsNativeCompaction: false,
        supportsPermissionPrompts: false,
        supportsDeferPermission: false,
        selfManagedAutoCompaction: false,
      };
    default:
      return {
        supportsResume: false,
        supportsForkSession: false,
        supportsNativeCompaction: false,
        supportsPermissionPrompts: false,
        supportsDeferPermission: false,
        selfManagedAutoCompaction: false,
      };
  }
}
