import type { MobileInputRequest } from '../../shared/types/mobile-gateway.types';

type ValidatedInput = MobileInputRequest & { idempotencyKey?: string };

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Shared strict boundary for Send and Steer. Errors never include message/attachment data. */
export function validateMobileInput(body: unknown): ValidatedInput | null {
  if (!plainObject(body) || Object.keys(body).some(key => !['message', 'attachments', 'idempotencyKey'].includes(key))) return null;
  if (body['message'] !== undefined && typeof body['message'] !== 'string') return null;
  const message = (body['message'] ?? '') as string;
  if (message.length > 500_000) return null;
  const attachments = body['attachments'];
  if (attachments !== undefined) {
    if (!Array.isArray(attachments) || attachments.length > 10) return null;
    for (const attachment of attachments) {
      if (!plainObject(attachment) || Object.keys(attachment).some(key => !['name', 'type', 'size', 'data'].includes(key))) return null;
      if (typeof attachment['name'] !== 'string' || attachment['name'].length > 500 ||
          typeof attachment['type'] !== 'string' || attachment['type'].length > 100 ||
          typeof attachment['data'] !== 'string' ||
          typeof attachment['size'] !== 'number' || !Number.isSafeInteger(attachment['size']) ||
          attachment['size'] < 0 || attachment['size'] > 50 * 1024 * 1024) return null;
    }
  }
  if (!message.trim() && !(attachments as unknown[] | undefined)?.length) return null;
  const idempotencyKey = body['idempotencyKey'];
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 500)) return null;
  return { message, ...(attachments === undefined ? {} : { attachments }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }) } as ValidatedInput;
}
