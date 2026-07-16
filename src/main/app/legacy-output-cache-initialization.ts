import { app } from 'electron';
import { getLogger } from '../logging/logger';
import {
  LegacyOutputCacheReconciler,
  type LegacyOutputCacheReconciliationReport,
} from '../context-evidence/legacy-output-cache-reconciler';
import type { AppInitializationStep } from './initialization-steps';

const logger = getLogger('LegacyOutputCacheInitialization');

export function createLegacyOutputCacheReconciliationStep(
  reconcile: () => Promise<LegacyOutputCacheReconciliationReport> = reconcileLegacyOutputCache,
): AppInitializationStep {
  return {
    name: 'Legacy output cache reconciliation',
    fn: async () => {
      try {
        const report = await reconcile();
        if (report.failures.length > 0) {
          logger.warn('Legacy output cache reconciliation preserved unreconciled copies', {
            scanned: report.scanned,
            migrated: report.migrated,
            deleted: report.deleted,
            failureCodes: [...new Set(report.failures.map((failure) => failure.code))],
          });
        }
      } catch (error) {
        logger.warn('Legacy output cache reconciliation failed; legacy copies were preserved', {
          errorCode: startupErrorCode(error),
        });
      }
    },
  };
}

async function reconcileLegacyOutputCache(): Promise<LegacyOutputCacheReconciliationReport> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getConversationLedgerService } = require('../conversation-ledger') as typeof import('../conversation-ledger');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getContextEvidenceCoordinator } = require(
    '../context-evidence/context-evidence-coordinator'
  ) as typeof import('../context-evidence/context-evidence-coordinator');
  return new LegacyOutputCacheReconciler({
    userDataPath: app.getPath('userData'),
    ledger: getConversationLedgerService(),
    coordinator: getContextEvidenceCoordinator(),
  }).reconcile();
}

function startupErrorCode(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : 'LEGACY_CACHE_RECONCILIATION_FAILED';
}
