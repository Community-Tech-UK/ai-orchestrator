import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { CopilotRouteOutcome } from '../../../shared/types/copilot-account.types';
import type { CopilotAccountRoutingService } from '../../providers/copilot/copilot-account-routing-service';
import {
  CopilotRoutingError,
  attachCopilotRoute,
  copilotOriginForRoutingIntent,
  isCopilotRoutingError,
} from './copilot-route-preflight';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

function routingService(outcome: CopilotRouteOutcome): CopilotAccountRoutingService {
  return {
    resolveRouteForSpawn: vi.fn(async () => outcome),
  } as unknown as CopilotAccountRoutingService;
}

const okOutcome: CopilotRouteOutcome = {
  ok: true,
  route: {
    profileId: 'enterprise',
    source: 'owner',
    ruleId: 'rule-1',
    executionNodeId: 'local',
    profileLabel: 'Enterprise',
    expectedLogin: 'octocat',
    host: 'github.com',
  },
};

describe('attachCopilotRoute', () => {
  it('is a no-op for every non-Copilot CLI type', async () => {
    const service = routingService(okOutcome);
    for (const cliType of ['claude', 'codex', 'antigravity', 'cursor', 'grok', 'ollama'] as const) {
      const options = { workingDirectory: '/w' };
      const result = await attachCopilotRoute(cliType, options, 'interactive', {
        routingService: service,
      });
      expect(result, cliType).toBe(options);
    }
    expect(service.resolveRouteForSpawn).not.toHaveBeenCalled();
  });

  it('attaches the resolved route for Copilot', async () => {
    const result = await attachCopilotRoute(
      'copilot',
      { workingDirectory: '/w' },
      'interactive',
      { routingService: routingService(okOutcome) },
    );
    expect(result.copilotAccountRoute?.profileId).toBe('enterprise');
    expect(result.workingDirectory).toBe('/w');
  });

  it('keeps an already-attached route instead of re-resolving', async () => {
    // A respawn must not re-run the rules: changing a rule affects new
    // sessions only, never a live thread.
    const service = routingService({
      ok: true,
      route: { ...okOutcome.ok ? okOutcome.route : okOutcome, profileId: 'personal' },
    } as CopilotRouteOutcome);
    const options = {
      workingDirectory: '/w',
      copilotAccountRoute: okOutcome.ok ? okOutcome.route : undefined,
    };
    const result = await attachCopilotRoute('copilot', options, 'interactive', {
      routingService: service,
    });
    expect(result.copilotAccountRoute?.profileId).toBe('enterprise');
    expect(service.resolveRouteForSpawn).not.toHaveBeenCalled();
  });

  it('throws a typed CopilotRoutingError on a blocked route', async () => {
    const failure: CopilotRouteOutcome = {
      ok: false,
      code: 'profile-identity-mismatch',
      detail: 'Reauthenticate this profile.',
      profileId: 'enterprise',
    };
    await expect(
      attachCopilotRoute('copilot', {}, 'loop', { routingService: routingService(failure) }),
    ).rejects.toBeInstanceOf(CopilotRoutingError);

    const error = await attachCopilotRoute('copilot', {}, 'loop', {
      routingService: routingService(failure),
    }).catch((caught: unknown) => caught);
    expect(isCopilotRoutingError(error)).toBe(true);
    expect((error as CopilotRoutingError).code).toBe('profile-identity-mismatch');
    expect((error as CopilotRoutingError).profileId).toBe('enterprise');
  });

  it('forwards origin, explicit profile, and node to the routing service', async () => {
    const service = routingService(okOutcome);
    await attachCopilotRoute('copilot', { workingDirectory: '/w' }, 'review', {
      routingService: service,
      explicitProfileId: 'personal',
      confirmProtectedOverride: true,
      persistedProfileId: 'enterprise',
      executionNodeId: 'worker-1',
      instanceId: 'inst-1',
    });
    expect(service.resolveRouteForSpawn).toHaveBeenCalledWith({
      workingDirectory: '/w',
      explicitProfileId: 'personal',
      confirmProtectedOverride: true,
      persistedProfileId: 'enterprise',
      origin: 'review',
      executionNodeId: 'worker-1',
      instanceId: 'inst-1',
    });
  });
});

describe('copilotOriginForRoutingIntent', () => {
  it('maps loop and workflow, and defaults everything else to an automatic origin', () => {
    expect(copilotOriginForRoutingIntent('loop')).toBe('loop');
    expect(copilotOriginForRoutingIntent('workflow')).toBe('workflow');
    // Never `interactive`: a manual-only profile must not be reachable from a
    // path that picked Copilot on the user's behalf.
    expect(copilotOriginForRoutingIntent('scaffolding')).toBe('internal');
    expect(copilotOriginForRoutingIntent('synthesis')).toBe('internal');
    expect(copilotOriginForRoutingIntent(undefined)).toBe('internal');
  });
});

/**
 * Acceptance criterion 12: every interactive and automatic Copilot
 * request-producing path passes through the central resolver.
 *
 * The synchronous throw in `createCliAdapter` is the runtime backstop; this is
 * the static one. Each production adapter-creating call site is classified
 * here, so ADDING a new one fails this test until it is either routed or
 * deliberately classified as unable to produce a Copilot request.
 */
describe('Copilot spawn-path bypass detection', () => {
  /** Files that create adapters and MUST call attachCopilotRoute. */
  const ROUTED_CALL_SITES = [
    'src/main/instance/instance-lifecycle.ts',
    'src/main/instance/lifecycle/instance-spawn-preflight-chain.ts',
    'src/main/orchestration/default-invokers.ts',
    'src/main/orchestration/default-loop-invoker-helpers.ts',
    'src/main/orchestration/cross-model-review-service.ts',
    'src/main/orchestration/consensus-coordinator.ts',
    'src/main/orchestration/multi-verify-coordinator.ts',
    'src/main/instance/auto-title-service.ts',
    'src/main/magic-prompts/magic-prompt-service.ts',
    'src/main/compare/council-provider-invoke.ts',
    'src/main/review/review-execution-host.ts',
    // Exec-mode entry point: the CLI verification dashboard reaches Copilot
    // through this provider, NOT through the adapter factory. It was invisible
    // to an earlier version of this scan that only looked for factory calls,
    // and shipped a live unrouted spawn path — hence the `new
    // CopilotCliAdapter(` pattern below.
    'src/main/providers/copilot-cli-provider.ts',
  ];

  /**
   * Files that construct adapters but cannot produce a Copilot model request,
   * each with the reason. A new entry here is a deliberate decision, not an
   * oversight.
   */
  const CLASSIFIED_EXEMPTIONS: Record<string, string> = {
    'src/main/cli/adapters/adapter-factory.ts':
      'The factory itself — it enforces the route rather than resolving it.',
    'src/main/providers/provider-runtime-service.ts':
      'Thin delegation to the factory; every caller routes first.',
    'src/main/instance/warm-start-manager.ts':
      'Never pre-warms Copilot — a warm process predates the account decision.',
    'src/main/instance/instance-manager.ts':
      'Warm-start spawn callback only; warm-start-manager refuses Copilot.',
    'src/main/instance/lifecycle/instance-spawner.ts':
      'Calls the instance-lifecycle adapter creator, which routes.',
    'src/main/instance/lifecycle/deferred-permission-handler.ts':
      'Calls the instance-lifecycle adapter creator, which routes.',
    'src/main/instance/lifecycle/runtime-reconciler.ts':
      'Calls the instance-lifecycle adapter creator, which routes.',
    'src/main/routing/hot-model-switcher.ts':
      'Adapter factory is caller-supplied and there is no production caller.',
    'src/worker-agent/local-instance-manager.ts':
      'Worker node: derives its own profile home and verifies the local binding.',
    'src/worker-agent/local-model-session-manager.ts':
      'Local-model runtimes only; never a Copilot CLI.',
    'src/main/ipc/cli-verification-ipc-handler.ts':
      'Constructs Copilot adapters only to list models; the conversation goes through CopilotCliProvider, which routes.',
    'src/main/mobile-gateway/mobile-gateway-model-handlers.ts':
      'Model listing only — no model request, so spec §10.2 installation-probe exemption applies.',
    'src/main/providers/cursor-copilot-cli-discovery-service.ts':
      'Model discovery only — no model request.',
    'src/main/instance/lifecycle/create-validation-helpers.ts':
      'Model listing for create-time validation; keyed by profile, issues no model request.',
    'src/main/orchestration/cli-verification-extension.ts':
      'Selects providers by name and calls CopilotCliProvider, which routes; never constructs an adapter itself.',
  };

  it('routes or explicitly classifies every production adapter-creating call site', () => {
    for (const file of ROUTED_CALL_SITES) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(source, `${file} must call attachCopilotRoute`).toContain('attachCopilotRoute');
    }
    // Every exemption names a real file and a real reason.
    for (const [file, reason] of Object.entries(CLASSIFIED_EXEMPTIONS)) {
      expect(() => readFileSync(join(REPO_ROOT, file), 'utf8'), file).not.toThrow();
      expect(reason.length, file).toBeGreaterThan(20);
    }
  });

  it('has no unclassified adapter-creating call site under src/', () => {
    // Deliberately a source scan rather than a hand-maintained list: a NEW
    // call site added later shows up here as an unclassified path.
    // An in-process, whitespace-insensitive scan rather than `grep`. Two
    // reasons: a line-based fixed-string match misses a reformatted
    // `createAdapter(\n  {`, and shelling out made the result depend on which
    // grep is on PATH — the very vacuous-pass hazard the assertion below
    // guards against.
    const { readdirSync } = require('fs') as typeof import('fs');
    const PATTERNS = [
      'createAdapter({',
      'createCliAdapter(',
      'createCopilotAdapter(',
      // Direct construction, NOT just the factory. Omitting this is what let
      // `CopilotCliProvider` ship a live unrouted Copilot spawn path while
      // this very test reported full coverage.
      'new CopilotCliAdapter(',
      'new AcpCliAdapter(',
    ];
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel, out);
        else if (entry.name.endsWith('.ts')) out.push(rel);
      }
      return out;
    };
    const found = [...walk('src/main'), ...walk('src/worker-agent')]
      .filter((file) => !file.includes('.spec.') && !file.includes('__tests__'))
      .filter((file) => {
        // Collapsing whitespace makes the match survive any reformatting of
        // the call site, which a line-oriented scan cannot.
        const source = readFileSync(join(REPO_ROOT, file), 'utf8').replace(/\s+/g, '');
        return PATTERNS.some((pattern) => source.includes(pattern.replace(/\s+/g, '')));
      });

    // Guard against a vacuous pass: if the scan found nothing (wrong cwd,
    // different grep on PATH), an empty `unclassified` would look like success.
    expect(found.length, 'source scan found no adapter-creating files').toBeGreaterThanOrEqual(10);

    const known = new Set([...ROUTED_CALL_SITES, ...Object.keys(CLASSIFIED_EXEMPTIONS)]);
    const unclassified = found.filter((file) => !known.has(file));
    expect(
      unclassified,
      'New adapter-creating call sites must either call attachCopilotRoute or be classified in CLASSIFIED_EXEMPTIONS',
    ).toEqual([]);
  });
});
