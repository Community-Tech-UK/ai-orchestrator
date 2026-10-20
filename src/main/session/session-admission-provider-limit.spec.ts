/**
 * The 2026-10-19 restart incident, end to end through the real admission
 * service, limit handler and ledger: a parent restarted on an account at a
 * known usage limit must not be sent its queued child reports (each one was
 * refused, keeping it too busy for the account switch). They wait, the switch
 * starts, and the reports go out once the session runs on the new account.
 */
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { AccountFailoverOutcome, AccountFailoverParams } from '../providers/account-pool/account-failover-coordinator';

let testDb: SqliteDriver;
vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => testDb }) }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ProviderLimitLedger, createProviderLimitLedgerSchema } from '../core/system/provider-limit-ledger';
import { InstanceProviderLimitHandler } from '../instance/instance-provider-limit-handler';
import { _resetSessionAdmissionServiceForTesting, getSessionAdmissionService, type AdmissionInstanceView } from './session-admission-service';
import { SessionAdmissionStore } from './session-admission-store';

class Host extends EventEmitter {
  view: AdmissionInstanceView = { status: 'error' as never };
  getInstance(): AdmissionInstanceView {
    return this.view;
  }
  ready(): void {
    this.view = { status: 'idle' as never };
    this.emit('instance:state-update', { instanceId: 'parent', status: 'idle' });
  }
}

describe('orchestration responses after a restart onto a limited account', () => {
  let account: string;
  let finishSwitch!: (outcome: AccountFailoverOutcome) => void;
  const performed: AccountFailoverParams[] = [];

  beforeEach(() => {
    testDb = new Database(':memory:') as unknown as SqliteDriver;
    SessionAdmissionStore._resetForTesting();
    _resetSessionAdmissionServiceForTesting();
    performed.length = 0;
    account = 'comtech';
  });

  it('holds the queued reports, starts the switch, and delivers them on the new account', async () => {
    const ledgerDb = new Database(':memory:') as unknown as SqliteDriver;
    createProviderLimitLedgerSchema(ledgerDb);
    const ledger = new ProviderLimitLedger(ledgerDb);
    ledger.record({
      provider: 'codex', model: null, accountProfileId: 'comtech', detectedAt: Date.now(),
      resumeAt: Date.now() + 6 * 24 * 60 * 60_000, source: 'provider-limit-signal', instanceId: 'parent',
    });
    const limits = new InstanceProviderLimitHandler();
    limits.configure({
      isEnabled: () => true,
      setWaitReason: vi.fn(),
      resendInput: vi.fn(),
      getQuotaSnapshot: () => null,
      getWorkspaceCwd: () => '/tmp/w',
      scheduleResume: () => () => undefined,
      providerLimitLedger: ledger,
      getProviderModel: () => ({ provider: 'codex', model: null, accountProfileId: account }),
      accountFailover: {
        plan: () => ({ kind: 'switch' }),
        perform: (params) => {
          performed.push(params);
          return new Promise<AccountFailoverOutcome>((resolve) => { finishSwitch = resolve; });
        },
        offer: vi.fn(),
        shouldSwitchPreemptively: () => false,
        release: vi.fn(),
      },
      emitSystemMessage: vi.fn(),
    });

    const host = new Host();
    const admission = getSessionAdmissionService();
    admission.setInstanceManager(host);
    admission.setProviderLimitHold((id) => limits.holdAutomatedTurn(id));
    const delivered: string[] = [];
    admission.registerRedeliveryHandler('orchestration', (ctx) => {
      delivered.push(ctx.message);
      admission.markDelivered(ctx.admissionId);
    });

    // Reports that arrived while the parent was in error are queued.
    for (const child of ['a', 'b', 'c']) {
      expect(admission.admitAutomatedWrite({ instanceId: 'parent', origin: 'orchestration', message: `child ${child} done` }))
        .toMatchObject({ kind: 'suppressed', reason: 'terminal' });
    }

    // The restart resumes on the limited account: nothing is sent, and the switch starts once.
    host.ready();
    expect(delivered).toEqual([]);
    await vi.waitFor(() => expect(performed).toHaveLength(1));
    expect(performed[0]).toMatchObject({ exhaustedProfileId: 'comtech', resumePrompt: null });

    // Further ready edges during the switch still hold.
    host.ready();
    expect(delivered).toEqual([]);

    // The switch lands the session on the other account; its respawn's ready edge delivers all three.
    account = 'legacy';
    finishSwitch({ outcome: 'switched', toProfileId: 'legacy', continuity: 'native-resume' });
    await Promise.resolve();
    host.ready();
    expect(delivered).toEqual(['child a done', 'child b done', 'child c done']);
    expect(performed).toHaveLength(1);
    ledgerDb.close();
  });
});
