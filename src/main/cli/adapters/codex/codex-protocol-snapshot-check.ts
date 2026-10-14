import { CODEX_APP_SERVER_PROTOCOL_VERSION } from './generated/app-server-protocol.gen';
import { getCliDetectionService } from '../../cli-detection';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CodexProtocolSnapshot');
let warned = false;

function parseVersion(value: string | undefined | null): number[] | null {
  const match = /^(?:codex-cli )?(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '');
  return match ? match.slice(1).map(Number) : null;
}

/** Patch bumps do not count; a new major always represents an older snapshot. */
export function describeSnapshotGap(snapshotVersion: string | undefined | null, installedVersion: string | undefined | null): number | null {
  const snapshot = parseVersion(snapshotVersion);
  const installed = parseVersion(installedVersion);
  if (!snapshot || !installed || installed[0] < snapshot[0]) return null;
  if (installed[0] > snapshot[0]) return Math.max(1, installed[1] - snapshot[1]);
  return installed[1] > snapshot[1] ? installed[1] - snapshot[1] : null;
}

/** Fail-soft, with no probe or spawn-blocking work; an empty worker cache is harmless. */
export function warnOnceIfCodexSnapshotBehind(): void {
  if (warned) return;
  try {
    const installed = getCliDetectionService().peekCachedResult()?.detected.find(entry => entry.name === 'codex')?.version;
    const snapshot = CODEX_APP_SERVER_PROTOCOL_VERSION;
    const gap = describeSnapshotGap(snapshot, installed);
    if (gap === null) return;
    logger.warn(`Codex protocol snapshot is ${gap} minor versions behind the installed CLI`, { snapshot, installed });
    warned = true;
  } catch { /* Diagnostics must never prevent a Codex session from starting. */ }
}

export function _resetCodexSnapshotCheckForTesting(): void { warned = false; }
