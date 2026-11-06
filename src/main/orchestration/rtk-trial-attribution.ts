import type { CostAttributionRecord } from '../core/system/cost-attribution';
import type { RtkSpawnConfig } from '../cli/rtk/rtk-rollout';

/** Trial fields for a one-shot cost row, so the row joins the same native session as the RTK trial exposure. */
export function oneShotTrialMetadata(
  provider: string | undefined,
  sessionId: string | undefined,
  rtk: RtkSpawnConfig | undefined,
  yoloMode: boolean,
): Pick<CostAttributionRecord, 'rtkArm' | 'rtkTrialEligible' | 'rtkTrialKey' | 'rtkTrialSurface'> {
  const eligible = provider === 'claude' && yoloMode && !!sessionId
    && rtk?.rtkTrialEligible === true && !!rtk.rtkTrialKey;
  return {
    rtkArm: eligible ? rtk?.rtkArm : undefined,
    ...(eligible ? { rtkTrialEligible: true, rtkTrialKey: rtk?.rtkTrialKey,
      rtkTrialSurface: 'loop' as const } : {}),
  };
}
