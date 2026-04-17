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
} from '../observability.schemas';

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
      SearchConfigureExaPayloadSchema,
    ];
    for (const schema of schemas) {
      expect(typeof schema.parse).toBe('function');
    }
  });
});
