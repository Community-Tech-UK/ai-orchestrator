import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import type { UserActionRequest } from './user-action-request.types';

export function coerceSecretRequest(
  metadata: Record<string, unknown> | undefined,
): UserActionRequest['secretRequest'] | undefined {
  if (!metadata) {
    return undefined;
  }
  const name = typeof metadata['name'] === 'string' ? metadata['name'].trim() : '';
  if (!name) {
    return undefined;
  }
  const label = typeof metadata['label'] === 'string' ? metadata['label'] : name;
  const purpose = typeof metadata['purpose'] === 'string' ? metadata['purpose'] : '';
  const expectedFormat = metadata['expectedFormat'];
  const format =
    expectedFormat === 'github_pat'
    || expectedFormat === 'openai_key'
    || expectedFormat === 'bearer'
    || expectedFormat === 'opaque'
      ? expectedFormat
      : undefined;
  return { name, label, purpose, expectedFormat: format };
}

export function isSecretRequest(request: UserActionRequest): boolean {
  return request.requestType === 'secret_required' && Boolean(request.secretRequest?.name);
}

export class SecretCardDrafts {
  private readonly values = new Map<string, string>();

  set(requestId: string, value: string): void {
    this.values.set(requestId, value);
  }

  has(requestId: string): boolean {
    return (this.values.get(requestId) || '').trim().length > 0;
  }

  take(requestId: string): string {
    const value = this.values.get(requestId) || '';
    this.values.delete(requestId);
    return value;
  }

  clear(requestId: string): void {
    this.values.delete(requestId);
  }
}

export interface SecretCardIpc {
  submitSecretCard(payload: {
    instanceId: string;
    requestId: string;
    name: string;
    label?: string;
    purpose?: string;
    value: string;
  }): Promise<IpcResponse>;
  declineSecretCard(payload: {
    instanceId: string;
    requestId: string;
    name: string;
    reason?: string;
  }): Promise<IpcResponse>;
}

export async function submitSecretCardDraft(
  ipc: SecretCardIpc,
  request: UserActionRequest,
  value: string,
): Promise<IpcResponse> {
  const secret = request.secretRequest;
  if (!secret || !value.trim()) {
    return { success: false, error: { message: 'A secret value is required' } };
  }
  return ipc.submitSecretCard({
    instanceId: request.instanceId,
    requestId: request.id,
    name: secret.name,
    label: secret.label,
    purpose: secret.purpose,
    value,
  });
}

export async function declineSecretCardDraft(
  ipc: SecretCardIpc,
  request: UserActionRequest,
): Promise<IpcResponse> {
  const secret = request.secretRequest;
  if (!secret) {
    return { success: false, error: { message: 'That secret request is no longer available.' } };
  }
  return ipc.declineSecretCard({
    instanceId: request.instanceId,
    requestId: request.id,
    name: secret.name,
  });
}
