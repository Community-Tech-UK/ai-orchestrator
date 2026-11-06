import type { NewSessionDraftService } from './new-session-draft.service';
import { getDefaultAgent } from '../../../../shared/types/agent.types';
export interface ComposerSnapshot {
  key: string;
  workingDirectory: string | null;
  nodeId: string | null;
  prompt: string;
  folders: string[];
  agentId: string;
  files: File[];
}
export function snapshotActiveComposer(service: NewSessionDraftService): ComposerSnapshot {
  return { key: service.activeKey(), workingDirectory: service.workingDirectory(), nodeId: service.nodeId(),
    prompt: service.prompt(), folders: [...service.pendingFolders()], agentId: service.agentId(), files: [...service.pendingFiles()] };
}
export function restoreComposerSnapshot(service: NewSessionDraftService, snap: ComposerSnapshot): boolean {
  if (service.activeKey() !== snap.key) service.open(snap.workingDirectory, snap.nodeId, { hintWorkspace: false });
  const existing = service.prompt();
  service.setPrompt(snap.prompt && existing ? `${snap.prompt}\n\n${existing}` : snap.prompt || existing);
  for (const folder of snap.folders) service.addPendingFolder(folder);
  if (service.agentId() === getDefaultAgent().id) service.setAgentId(snap.agentId);
  service.addPendingFiles(snap.files.filter((file) => !service.pendingFiles().includes(file)));
  return true;
}
