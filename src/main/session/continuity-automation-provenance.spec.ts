import { describe, expect, it } from 'vitest';
import {
  automationMetadataFromProvenance,
  automationProvenanceFromMetadata,
} from './continuity-automation-provenance';

describe('continuity automation provenance', () => {
  it('round-trips every automation key the runner stamps', () => {
    const metadata = {
      spendPurpose: 'automation',
      automationId: 'automation-1',
      automationRunId: 'run-1',
      automationHidden: true,
      automationRunSucceeded: true,
      automationRevealed: true,
    };

    const provenance = automationProvenanceFromMetadata(metadata);

    expect(provenance).toEqual({
      automationId: 'automation-1',
      automationRunId: 'run-1',
      hidden: true,
      runSucceeded: true,
      revealed: true,
    });
    expect(automationMetadataFromProvenance(provenance)).toEqual({
      automationId: 'automation-1',
      automationRunId: 'run-1',
      automationHidden: true,
      automationRunSucceeded: true,
      automationRevealed: true,
    });
  });

  it('records only what was stamped, so a visible or unfinished run stays visible', () => {
    expect(automationProvenanceFromMetadata({ automationId: 'automation-1', automationHidden: true }))
      .toEqual({ automationId: 'automation-1', hidden: true });
    expect(automationMetadataFromProvenance({ automationId: 'automation-1' }))
      .toEqual({ automationId: 'automation-1' });
  });

  it('preserves historical source without restoring engine ownership', () => {
    const metadata = { automationId: 'automation-1', automationSourceRunId: 'run-1', automationRevealed: true };
    expect(automationMetadataFromProvenance(automationProvenanceFromMetadata(metadata))).toEqual(metadata);
  });

  it('ignores sessions no automation started', () => {
    expect(automationProvenanceFromMetadata(undefined)).toBeUndefined();
    expect(automationProvenanceFromMetadata({ spendPurpose: 'automation' })).toBeUndefined();
    expect(automationProvenanceFromMetadata({ automationId: '  ' })).toBeUndefined();
    expect(automationMetadataFromProvenance(undefined)).toEqual({});
  });
});
