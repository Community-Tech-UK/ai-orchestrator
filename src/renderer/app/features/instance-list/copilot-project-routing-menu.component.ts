/**
 * "Copilot account" section of a project's three-dots menu.
 *
 * Mapping a repository to a GitHub account belongs where the project is, not
 * buried in Settings — you are looking at the project when you form the
 * intention. This resolves the project's current account, shows it, and maps it
 * in one click.
 *
 * It picks the RULE SHAPE for you: a repository with a GitHub remote gets an
 * owner rule (so every sibling repo in that org follows), and a checkout with
 * no remote gets a protected folder rule. Asking a user to choose between
 * "owner", "repository" and "path prefix" is asking them to learn the
 * resolver's precedence ladder, which is our problem, not theirs.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  CopilotAccountIpcService,
  type CopilotAccountRuleView,
  type CopilotAccountView,
  type DiscoveredCopilotAccount,
} from '../../core/services/ipc/copilot-account-ipc.service';
import type { CopilotRouteOutcome } from '../../../../shared/types/copilot-account.types';

const SIGN_IN_POLL_INTERVAL_MS = 2_000;
const SIGN_IN_POLL_TIMEOUT_MS = 180_000;

@Component({
  standalone: true,
  selector: 'app-copilot-project-routing-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="cpr-divider"></div>
      <div class="cpr-label">Copilot account</div>

      @for (account of accounts(); track account.id) {
        <button
          type="button"
          class="cpr-item"
          role="menuitem"
          [class.is-current]="account.id === activeProfileId()"
          [disabled]="busy()"
          (click)="mapTo(account, $event)"
        >
          <span class="cpr-tick" aria-hidden="true">{{
            account.id === activeProfileId() ? '✓' : ''
          }}</span>
          <span class="cpr-text">{{ account.label }}</span>
          @if (!isSignedIn(account)) {
            <span class="cpr-badge">Sign in</span>
          }
        </button>
      }

      @for (candidate of addable(); track candidate.login) {
        <button
          type="button"
          class="cpr-item"
          role="menuitem"
          [disabled]="busy()"
          (click)="addAndMapTo(candidate, $event)"
        >
          <span class="cpr-tick" aria-hidden="true"></span>
          <span class="cpr-text">{{ candidate.login }}</span>
          <span class="cpr-badge">Add</span>
        </button>
      }

      @if (mappedRules().length > 0) {
        <button
          type="button"
          class="cpr-item cpr-item--muted"
          role="menuitem"
          [disabled]="busy()"
          (click)="clearMapping($event)"
        >
          <span class="cpr-tick" aria-hidden="true"></span>
          <span class="cpr-text">Clear mapping</span>
        </button>
      }

      @if (onlyOneAccount()) {
        <div class="cpr-note">Add a second account in Settings to route between them.</div>
      }

      @if (blockedReason(); as reason) {
        <div class="cpr-note cpr-note--error" role="alert">{{ reason }}</div>
      }

      @if (error(); as message) {
        <div class="cpr-note cpr-note--error" role="alert">{{ message }}</div>
      }
    }
  `,
  styles: [`
    /* Self-contained on purpose. The host menu's .project-menu-item rules live
       in instance-list.component.scss and are view-encapsulated to THAT
       component, so they never reach this child's DOM — relying on them is what
       made these render as unstyled, centred, wrapping text. */
    .cpr-divider { height: 1px; margin: 4px 0; background: rgba(255, 255, 255, 0.06); }

    .cpr-label {
      padding: 2px 10px 4px;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--text-muted);
      opacity: 0.72;
    }

    .cpr-item {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      min-height: 32px;
      padding: 8px 10px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      transition: background var(--transition-fast), color var(--transition-fast);
    }

    .cpr-item:hover:not(:disabled),
    .cpr-item:focus-visible:not(:disabled) {
      outline: none;
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-primary);
    }

    .cpr-item:disabled { opacity: 0.5; cursor: default; }
    .cpr-item.is-current { color: var(--text-primary); }
    .cpr-item--muted { color: var(--text-muted); }

    /* Fixed gutter keeps labels aligned whether or not a tick is present. */
    .cpr-tick { flex: 0 0 10px; font-size: 11px; line-height: 1; }

    .cpr-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .cpr-badge {
      flex: 0 0 auto;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      font-size: 10px;
      color: var(--text-muted);
    }

    .cpr-note {
      padding: 2px 10px 6px;
      font-size: 11px;
      line-height: 1.35;
      color: var(--text-muted);
    }

    .cpr-note--error { color: var(--error-color, #d33); }
  `],
})
export class CopilotProjectRoutingMenuComponent {
  private readonly ipc = inject(CopilotAccountIpcService);

  /** Absolute path of the project this menu belongs to. */
  readonly projectPath = input<string | null>(null);
  /** Emitted after a successful change so the host can close the menu. */
  readonly mapped = output<void>();

  private readonly accountsSignal = signal<CopilotAccountView[]>([]);
  private readonly rulesSignal = signal<CopilotAccountRuleView[]>([]);
  private readonly outcomeSignal = signal<CopilotRouteOutcome | null>(null);
  private readonly addableSignal = signal<DiscoveredCopilotAccount[]>([]);
  private readonly busySignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);
  private loadedFor: string | null = null;

  readonly accounts = this.accountsSignal.asReadonly();
  readonly busy = this.busySignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();

  /**
   * Shown whenever Copilot has ANY account.
   *
   * An earlier version required two, which hid this in precisely the state
   * where it is most needed: with one account you cannot map anything, and a
   * silent menu gives you no way to find out why. Where a second account is
   * already signed in to Copilot but has no Harness profile, it is offered here
   * directly — adding and mapping in one action.
   */
  readonly visible = computed(
    () => this.accountsSignal().length > 0 || this.addableSignal().length > 0,
  );

  /** Signed in to Copilot, but no Harness profile yet. */
  readonly addable = computed(() =>
    this.addableSignal().filter((candidate) => !candidate.alreadyAdded),
  );

  /** True when there is nothing to choose between and nothing to add. */
  readonly onlyOneAccount = computed(
    () => this.accountsSignal().length <= 1 && this.addable().length === 0,
  );


  /**
   * Wait for an out-of-band sign-in to land, then refresh.
   *
   * `signIn` opens a terminal and returns immediately; the user finishes in a
   * browser seconds or minutes later. Without this the menu holds whatever it
   * read before the login — which is what made a successful sign-in still show
   * "Sign in". Bounded, so a login the user abandons cannot poll forever.
   */
  private async awaitSignIn(account: CopilotAccountView): Promise<void> {
    const deadline = Date.now() + SIGN_IN_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, SIGN_IN_POLL_INTERVAL_MS));
      if (this.projectPath() === null) return;
      const verified = await this.ipc.verifyBinding(account.id);
      if (!verified.success) continue;
      const state = (verified.data as { binding?: { state?: string } } | undefined)?.binding?.state;
      if (state === 'authenticated') {
        this.loadedFor = null;
        this.errorSignal.set(null);
        await this.load();
        return;
      }
    }
    this.errorSignal.set(
      `${account.label} is still not signed in on this device. Re-open this menu once the login finishes.`,
    );
  }

  /** A profile with no verified sign-in on this device cannot run a session. */
  isSignedIn(account: CopilotAccountView): boolean {
    return account.binding?.state === 'authenticated';
  }

  readonly activeProfileId = computed(() => {
    const outcome = this.outcomeSignal();
    return outcome?.ok ? outcome.route.profileId : null;
  });

  /**
   * Only surfaced when routing is BLOCKED. The healthy case is already shown by
   * the tick next to the account — repeating it as a header line was pure
   * duplication and the main source of visual clutter.
   */
  readonly blockedReason = computed(() => {
    const outcome = this.outcomeSignal();
    return outcome && !outcome.ok ? outcome.detail : null;
  });

  /** Rules that specifically target this project (not inherited defaults). */
  readonly mappedRules = computed(() => {
    const outcome = this.outcomeSignal();
    const ruleId = outcome?.ok ? outcome.route.ruleId : undefined;
    return ruleId ? this.rulesSignal().filter((rule) => rule.id === ruleId) : [];
  });

  constructor() {
    // The host renders this only while the menu is open, so construction IS
    // the open event — no host wiring, and nothing is fetched for the dozens of
    // projects whose menus are never opened.
    effect(() => {
      const path = this.projectPath();
      if (path) {
        void this.load();
      }
    });
  }

  /** Idempotent per path; safe to call repeatedly. */
  async load(): Promise<void> {
    const path = this.projectPath();
    if (!path || this.loadedFor === path) {
      return;
    }
    this.loadedFor = path;
    this.busySignal.set(true);
    try {
      const [accounts, rules, outcome, addable] = await Promise.all([
        this.ipc.list(),
        this.ipc.listRules(),
        this.ipc.previewRoute({ workingDirectory: path }),
        this.ipc.discover(),
      ]);
      this.accountsSignal.set(accounts);
      this.rulesSignal.set(rules);
      this.outcomeSignal.set(outcome);
      this.addableSignal.set(addable);
    } catch (error) {
      // Surface the real reason. A generic message here hid an IPC-level
      // rejection behind "could not read", which looked like a transient
      // glitch rather than the permanent, actionable failure it was.
      this.errorSignal.set(
        error instanceof Error && error.message
          ? error.message
          : 'Could not read Copilot accounts.',
      );
    } finally {
      this.busySignal.set(false);
    }
  }

  async mapTo(account: CopilotAccountView, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const path = this.projectPath();
    if (!path) return;

    this.busySignal.set(true);
    this.errorSignal.set(null);
    try {
      // Clicking the account this project ALREADY uses is a no-op, not an
      // error. It used to fall through to createRule and come back with
      // "that routing rule already exists for this account".
      if (this.activeProfileId() === account.id) {
        return;
      }
      // Each profile has its own isolated COPILOT_HOME, so a newly added
      // account has no credentials until it signs in. Mapping to it first would
      // just park the project on an account that cannot run — so open sign-in
      // here rather than sending the user to Settings to find it.
      if (!this.isSignedIn(account)) {
        const response = await this.ipc.signIn(account.id, account.host);
        if (!response.success) {
          this.errorSignal.set(response.error?.message ?? 'Could not start sign-in.');
          return;
        }
        this.errorSignal.set(`Finish signing in as ${account.label} in the terminal that opened…`);
        // The login completes in a terminal AFTER this returns, so nothing here
        // would ever re-read it: the menu kept showing "Sign in" over an
        // account that was by then signed in. Poll until the binding flips.
        void this.awaitSignIn(account);
        return;
      }
      const remotes = await this.ipc.suggestRules(path);
      // Prefer an OWNER rule: mapping one repo of an employer's org almost
      // always means "and the rest of them too", and a per-repo rule would
      // leave the siblings silently on the personal account.
      const remote = remotes[0];
      // `replaceExisting`: picking an account for a project IS a swap. Without
      // it, switching a project between accounts failed with "already routed to
      // a different Copilot account. Remove the existing rule first." — leaving
      // no way to change your mind from this menu.
      const response = remote
        ? await this.ipc.createRule({
            profileId: account.id,
            matcher: { type: 'owner', host: remote.host, owner: remote.owner },
            replaceExisting: true,
          })
        : await this.ipc.createRule({
            profileId: account.id,
            // No remote to key off, so pin by location — and protect it, so a
            // failure here blocks rather than falling back to the default.
            matcher: { type: 'path-prefix', canonicalPath: path },
            isProtected: true,
            replaceExisting: true,
          });
      if (!response.success && /protected/i.test(response.error?.message ?? '')) {
        // A protected rule exists to stop work inside an employer's scope
        // silently falling to another seat, so moving it is a decision, not a
        // click. Ask once, then honour the answer.
        const confirmed = globalThis.confirm(
          `${account.label} — this project is protected for another Copilot account. Move it anyway?`,
        );
        if (!confirmed) return;
        const retry = remote
          ? await this.ipc.createRule({
              profileId: account.id,
              matcher: { type: 'owner', host: remote.host, owner: remote.owner },
              replaceExisting: true,
              confirmProtectedOverride: true,
            })
          : await this.ipc.createRule({
              profileId: account.id,
              matcher: { type: 'path-prefix', canonicalPath: path },
              isProtected: true,
              replaceExisting: true,
              confirmProtectedOverride: true,
            });
        if (!retry.success) {
          this.errorSignal.set(retry.error?.message ?? 'That mapping could not be saved.');
          return;
        }
        this.loadedFor = null;
        await this.load();
        return;
      }
      if (!response.success) {
        this.errorSignal.set(response.error?.message ?? 'That mapping could not be saved.');
        return;
      }
      this.loadedFor = null;
      await this.load();
      this.mapped.emit();
    } catch (error) {
      this.errorSignal.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busySignal.set(false);
    }
  }

  /**
   * Add an account Copilot already holds, then route this project to it.
   *
   * The two-step version (Settings → add → back → map) is where this flow was
   * losing people: the account exists, the project is in front of you, and the
   * only thing missing is a profile record.
   */
  async addAndMapTo(candidate: DiscoveredCopilotAccount, event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const path = this.projectPath();
    if (!path) return;

    this.busySignal.set(true);
    this.errorSignal.set(null);
    try {
      const created = await this.ipc.create({
        label: candidate.login,
        // Record the identity we are adding. Without it the profile has no
        // `expectedLogin`, so discovery keeps offering the same account as a
        // fresh suggestion forever — the duplicate entry in the menu.
        expectedLogin: candidate.login,
        // Anything added at this point is a second account, so it starts
        // matched-only: it serves this project and whatever else you map, and
        // can never pick up unrelated work.
        accountKind: 'enterprise',
        host: candidate.host,
      });
      if (!created.success) {
        this.errorSignal.set(created.error?.message ?? 'That account could not be added.');
        return;
      }
      const profileId = (created.data as { id?: string } | undefined)?.id;
      if (!profileId) {
        this.errorSignal.set('That account was added but could not be mapped. Use Settings.');
        return;
      }
      // Save the mapping FIRST, then prompt for sign-in. Going through
      // `mapTo` would divert to sign-in before the rule existed, so finishing
      // the login would leave the project still unmapped — the user would have
      // to come back and pick the account a second time.
      this.loadedFor = null;
      await this.mapTo(
        { id: profileId, label: candidate.login, host: candidate.host,
          binding: { nodeId: 'local', state: 'authenticated', checkedAt: 0 } } as CopilotAccountView,
        event,
      );
      // A profile added for an account this machine already holds inherits that
      // identity, so check before asking for a login the user has already done.
      const verified = await this.ipc.verifyBinding(profileId);
      const state = (verified.data as { binding?: { state?: string } } | undefined)?.binding?.state;
      if (verified.success && state === 'authenticated') {
        this.loadedFor = null;
        this.errorSignal.set(null);
        await this.load();
        return;
      }
      const signIn = await this.ipc.signIn(profileId, candidate.host);
      this.errorSignal.set(
        signIn.success
          ? `Mapped. Finish signing in as ${candidate.login} in the terminal that just opened.`
          : signIn.error?.message ?? 'Mapped, but sign-in could not be started.',
      );
      if (signIn.success) {
        void this.awaitSignIn(
          { id: profileId, label: candidate.login, host: candidate.host } as CopilotAccountView,
        );
      }
    } catch (error) {
      this.errorSignal.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busySignal.set(false);
    }
  }

  async clearMapping(event: Event): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const rules = this.mappedRules();
    if (rules.length === 0) return;

    this.busySignal.set(true);
    this.errorSignal.set(null);
    try {
      for (const rule of rules) {
        const response = await this.ipc.removeRule(rule.id);
        if (!response.success) {
          this.errorSignal.set(response.error?.message ?? 'That rule could not be removed.');
          return;
        }
      }
      this.loadedFor = null;
      await this.load();
      this.mapped.emit();
    } finally {
      this.busySignal.set(false);
    }
  }
}
