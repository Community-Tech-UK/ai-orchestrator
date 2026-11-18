/**
 * The adapter of a live-test question session: the real ACP adapter, with a
 * scripted in-process agent in place of the provider's process. Everything
 * from the protocol up (the question and permission cards, answers, receipts,
 * cancel and exit handling) is the code a real session runs.
 */

import type { ChildProcess } from 'node:child_process';
import { AcpCliAdapter } from './acp-cli-adapter';
import { buildAcpPermissionContext } from './adapter-spawn-helpers';
import type { UnifiedSpawnOptions } from './adapter-factory.types';
import { LiveTestQuestionPeer } from './live-test-question-peer';
import type { CliStatus } from './base-cli-adapter.types';
import { getPermissionRegistry } from '../../orchestration/permission-registry';
import { isLiveTestQuestionFolder } from './live-test-question-fixtures';
import type { CliType } from '../cli-detection';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';

export class LiveTestQuestionAdapter extends AcpCliAdapter {
  private peer: LiveTestQuestionPeer | null = null;

  constructor(options: UnifiedSpawnOptions) {
    super({
      adapterName: 'live-test-question-acp',
      command: 'live-test-question-peer',
      workingDirectory: options.workingDirectory ?? process.cwd(),
      permissionRegistry: getPermissionRegistry(),
      // Never YOLO: a YOLO session would answer the permission card for itself.
      permissionContext: buildAcpPermissionContext({ ...options, yoloMode: false }, 'live-test-question'),
    });
    // The question form is only turned into a native card for OpenCode 2 sessions.
    this.configureOpenCodeV2(true);
  }

  override async checkStatus(): Promise<CliStatus> {
    return { available: true };
  }

  protected override spawnProcess(args: string[]): ChildProcess {
    void args;
    this.peer = new LiveTestQuestionPeer();
    return this.peer as unknown as ChildProcess;
  }

  override async terminate(): Promise<void> {
    try {
      // The peer has no process to signal, so there is nothing to wait for.
      await super.terminate(false);
    } finally {
      this.peer?.close();
      this.peer = null;
    }
  }
}

/**
 * The adapter for a session made by the live-test handler, found by its folder
 * on every spawn; null for any other session, and always null outside a
 * live-test app. A fixture folder with another provider or a remote placement
 * is refused rather than started as a real session.
 */
export function createLiveTestQuestionAdapter(
  cliType: CliType,
  options: UnifiedSpawnOptions,
  executionLocation?: ExecutionLocation,
): LiveTestQuestionAdapter | null {
  if (!isLiveTestQuestionFolder(options.workingDirectory)) return null;
  if (cliType !== 'opencode' || executionLocation?.type === 'remote') {
    throw new Error('A live-test question session runs locally as an OpenCode session.');
  }
  return new LiveTestQuestionAdapter(options);
}
