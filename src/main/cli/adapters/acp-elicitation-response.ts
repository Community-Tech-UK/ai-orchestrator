/**
 * Maps a user's free-text answer onto an ACP `elicitation/create` response.
 * Pure; extracted from acp-cli-adapter.ts to keep that file under its size
 * ceiling. Behaviour is unchanged.
 */

import type { AcpElicitationCreateParams } from '../../../shared/types/cli.types';

export type AcpElicitationResponse =
  | { action: 'accept'; content?: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' };

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function buildAcpElicitationResponse(
  params: AcpElicitationCreateParams | undefined,
  responseText: string,
): AcpElicitationResponse {
  const normalized = slug(responseText);
  if (!normalized || normalized === 'cancel') {
    return { action: 'cancel' };
  }
  if (normalized === 'decline' || normalized === 'deny' || normalized === 'reject' || normalized === 'no') {
    return { action: 'decline' };
  }

  return {
    action: 'accept',
    content: buildElicitationContent(params, responseText),
  };
}

function buildElicitationContent(
  params: AcpElicitationCreateParams | undefined,
  responseText: string,
): Record<string, unknown> {
  const trimmed = responseText.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to schema-guided wrapping below.
    }
  }

  const schema = params?.requestedSchema ?? params?.schema;
  const properties = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? schema['properties']
    : undefined;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const keys = Object.keys(properties);
    if (keys.length === 1 && keys[0]) {
      const propertySchema = (properties as Record<string, unknown>)[keys[0]];
      return {
        [keys[0]]: coerceElicitationValue(trimmed, propertySchema),
      };
    }
  }

  return { response: trimmed };
}

function coerceElicitationValue(value: string, schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return value;
  }

  const type = (schema as Record<string, unknown>)['type'];
  if (type === 'boolean') {
    const normalized = slug(value);
    if (['true', 'yes', 'y', '1', 'approve', 'accept'].includes(normalized)) {
      return true;
    }
    if (['false', 'no', 'n', '0', 'deny', 'decline', 'reject'].includes(normalized)) {
      return false;
    }
  }
  if (type === 'integer') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (type === 'number') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  return value;
}
