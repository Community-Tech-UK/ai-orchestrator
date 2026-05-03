import { describe, expect, it } from 'vitest';
import {
  KgAddFactPayloadSchema,
  KgInvalidateFactPayloadSchema,
  KgQueryEntityPayloadSchema,
  KgQueryRelationshipPayloadSchema,
  KgTimelinePayloadSchema,
  KgAddEntityPayloadSchema,
  ConvoImportFilePayloadSchema,
  ConvoImportStringPayloadSchema,
  ConvoDetectFormatPayloadSchema,
  WakeGeneratePayloadSchema,
  WakeAddHintPayloadSchema,
  WakeRemoveHintPayloadSchema,
  WakeSetIdentityPayloadSchema,
  WakeListHintsPayloadSchema,
  CodebaseMineDirectoryPayloadSchema,
  CodebaseGetStatusPayloadSchema,
  ProjectKnowledgeGetEvidencePayloadSchema,
  ProjectKnowledgeRefreshCodeIndexPayloadSchema,
} from '../knowledge.schemas';

describe('knowledge.schemas', () => {
  it('KgAddFactPayloadSchema requires fact', () => {
    expect(() => KgAddFactPayloadSchema.parse({})).toThrow();
  });

  it('exports all knowledge-group schemas as Zod schemas', () => {
    const schemas = [
      KgAddFactPayloadSchema, KgInvalidateFactPayloadSchema,
      KgQueryEntityPayloadSchema, KgQueryRelationshipPayloadSchema,
      KgTimelinePayloadSchema, KgAddEntityPayloadSchema,
      ConvoImportFilePayloadSchema, ConvoImportStringPayloadSchema,
      ConvoDetectFormatPayloadSchema,
      WakeGeneratePayloadSchema, WakeAddHintPayloadSchema,
      WakeRemoveHintPayloadSchema, WakeSetIdentityPayloadSchema,
      WakeListHintsPayloadSchema,
      CodebaseMineDirectoryPayloadSchema, CodebaseGetStatusPayloadSchema,
      ProjectKnowledgeGetEvidencePayloadSchema, ProjectKnowledgeRefreshCodeIndexPayloadSchema,
    ];
    for (const schema of schemas) {
      expect(typeof schema.parse).toBe('function');
    }
  });
});
