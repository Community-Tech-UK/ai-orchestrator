import type { IpcRenderer } from 'electron';
import type { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type { SavedPermissionRule } from '../../shared/types/saved-permission-rule.types';

export function createPermissionRulesDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    permissionListUserRules: (): Promise<IpcResponse<SavedPermissionRule[]>> => ipcRenderer.invoke(ch.PERMISSION_LIST_USER_RULES),
    permissionRemoveUserRule: (ruleId: string): Promise<IpcResponse<boolean>> => ipcRenderer.invoke(ch.PERMISSION_REMOVE_USER_RULE, { ruleId }),
  };
}
