import type { DesktopAppDescriptor, DesktopGatewayContext } from '../../shared/types/desktop-gateway.types';
import {
  COMPUTER_USE_AUTONOMY_LEVELS,
  type ComputerUseAutonomyLevel,
} from '../../shared/types/desktop-gateway-settings.types';
import type { AppSettings } from '../../shared/types/settings.types';
import {
  getInstanceComputerUseMode,
  resolveComputerUseAutonomy,
  type ResolvedComputerUseAutonomy,
} from '../instance/lifecycle/computer-use-scoping';
import { decideDesktopAppPolicy } from './desktop-app-policy';

export interface DesktopGatewaySettingsReader {
  get<K extends keyof Pick<
    AppSettings,
    | 'computerUseEnabled'
    | 'computerUseAllowedAppsJson'
    | 'computerUseDeniedAppsJson'
    | 'computerUseRequireApprovalForInput'
    | 'computerUseStoreScreenshotsForEscalations'
    | 'computerUseAutonomyLevel'
  >>(key: K): AppSettings[K];
}

export function withResolvedComputerUseAutonomy(
  autonomy: ResolvedComputerUseAutonomy,
  metadata: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...metadata,
    autonomyLevel: autonomy.level,
    autonomySource: autonomy.source,
  };
}

/** Resolves and applies the live-session Computer Use policy at call boundaries. */
export class DesktopComputerUsePolicy {
  constructor(private readonly settings: DesktopGatewaySettingsReader) {}

  globalLevel(): ComputerUseAutonomyLevel {
    const raw = this.settings.get('computerUseAutonomyLevel');
    return COMPUTER_USE_AUTONOMY_LEVELS.includes(raw) ? raw : 'trusted';
  }

  resolve(context: DesktopGatewayContext): ResolvedComputerUseAutonomy {
    return resolveComputerUseAutonomy(
      getInstanceComputerUseMode(context.instanceId),
      this.globalLevel(),
    );
  }

  describeChange(
    previousMode: ComputerUseAutonomyLevel | undefined,
    nextMode: ComputerUseAutonomyLevel | undefined,
  ): Record<string, unknown> {
    const globalLevel = this.globalLevel();
    const previous = resolveComputerUseAutonomy(previousMode, globalLevel);
    const next = resolveComputerUseAutonomy(nextMode, globalLevel);
    return {
      previousLevel: previous.level,
      previousSource: previous.source,
      newLevel: next.level,
      newSource: next.source,
      decidedBy: 'user',
    };
  }

  annotate(
    context: DesktopGatewayContext,
    app: DesktopAppDescriptor,
    autonomy: ResolvedComputerUseAutonomy = this.resolve(context),
  ): DesktopAppDescriptor {
    const decision = decideDesktopAppPolicy(app, this.settings, autonomy.level);
    return {
      ...app,
      policyStatus: decision.status,
      ...(decision.reason ? { blockedReason: decision.reason } : {}),
    };
  }
}
