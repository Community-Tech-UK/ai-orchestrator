import { describe, expect, it } from 'vitest';
import {
  LogGetRecentPayloadSchema,
  LogSetLevelPayloadSchema,
  LogSetSubsystemLevelPayloadSchema,
  LogExportPayloadSchema,
  DebugAgentPayloadSchema,
  DebugConfigPayloadSchema,
  DebugFilePayloadSchema,
  DebugAllPayloadSchema,
  SearchSemanticPayloadSchema,
  SearchBuildIndexPayloadSchema,
  SearchConfigureExaPayloadSchema,
  SessionRecallSearchPayloadSchema,
} from '../observability.schemas';

const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

describe('observability.schemas', () => {
  it('SearchSemanticPayloadSchema requires query', () => {
    expect(() => SearchSemanticPayloadSchema.parse({})).toThrow();
  });

  it('exports all observability-group schemas as Zod schemas', () => {
    const schemas = [
      LogGetRecentPayloadSchema, LogSetLevelPayloadSchema,
      LogSetSubsystemLevelPayloadSchema, LogExportPayloadSchema,
      DebugAgentPayloadSchema, DebugConfigPayloadSchema, DebugFilePayloadSchema,
      DebugAllPayloadSchema,
      SearchSemanticPayloadSchema, SearchBuildIndexPayloadSchema,
      SearchConfigureExaPayloadSchema, SessionRecallSearchPayloadSchema,
    ];
    for (const schema of schemas) {
      expect(typeof schema.parse).toBe('function');
    }
  });

  it('accepts session recall model filters up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    const parsed = SessionRecallSearchPayloadSchema.parse({
      query: 'prior failures',
      model: maxCatalogModelId,
    });

    expect(parsed.model).toBe(maxCatalogModelId);
  });

  it('rejects session recall model filters beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    expect(SessionRecallSearchPayloadSchema.safeParse({
      query: 'prior failures',
      model: tooLongCatalogModelId,
    }).success).toBe(false);
  });
});
