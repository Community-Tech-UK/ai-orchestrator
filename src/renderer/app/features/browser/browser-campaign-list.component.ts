import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { BrowserProfile } from '@contracts/types/browser';
import { BrowserUnattendedStore } from './browser-unattended.store';
import {
  CAMPAIGN_ALLOWED_ACTION_CLASSES,
  CAMPAIGN_MAX_DURATION_MS,
  type BrowserCampaignListItem,
  type CampaignActionClass,
} from './browser-unattended.types';

const HOUR_MS = 60 * 60 * 1000;
const DECLARATION_HASH_PATTERN = /^[a-f0-9]{64}$/i;

interface CampaignBudgetDraft {
  maxActions: number;
  maxSubmits: number;
  maxNewAccounts: number;
  maxUploads: number;
  durationHours: number;
}

function defaultBudgetDraft(): CampaignBudgetDraft {
  return { maxActions: 100, maxSubmits: 20, maxNewAccounts: 0, maxUploads: 0, durationHours: 8 };
}

@Component({
  selector: 'app-browser-campaign-list',
  standalone: true,
  imports: [],
  templateUrl: './browser-campaign-list.component.html',
  styleUrl: './browser-campaign-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserCampaignListComponent implements OnInit {
  private readonly store = inject(BrowserUnattendedStore);

  readonly profiles = input<BrowserProfile[]>([]);

  readonly campaigns = this.store.campaigns;
  readonly campaignDetails = this.store.campaignDetails;
  readonly busy = this.store.busy;
  readonly errorMessage = this.store.errorMessage;
  readonly validationError = signal<string | null>(null);

  readonly allowedActionClasses = CAMPAIGN_ALLOWED_ACTION_CLASSES;
  readonly maxDurationHours = CAMPAIGN_MAX_DURATION_MS / HOUR_MS;

  readonly selectedProfileId = signal('');
  readonly label = signal('');
  readonly originsText = signal('');
  readonly selectedActionClasses = signal<Set<CampaignActionClass>>(new Set());
  readonly budgetDraft = signal<CampaignBudgetDraft>(defaultBudgetDraft());

  readonly expandedCampaignId = signal<string | null>(null);
  readonly declarationHashDrafts = signal<Record<string, string>>({});

  constructor() {
    effect(() => {
      const profiles = this.profiles();
      if (!this.selectedProfileId() && profiles.length > 0) {
        this.selectedProfileId.set(profiles[0]!.id);
      }
    });
  }

  ngOnInit(): void {
    void this.store.refreshCampaigns();
  }

  onProfileChange(event: Event): void {
    this.selectedProfileId.set((event.target as HTMLSelectElement).value);
  }

  onLabelInput(event: Event): void {
    this.label.set((event.target as HTMLInputElement).value);
  }

  onOriginsInput(event: Event): void {
    this.originsText.set((event.target as HTMLTextAreaElement).value);
  }

  toggleActionClass(actionClass: CampaignActionClass): void {
    this.selectedActionClasses.update((current) => {
      const next = new Set(current);
      if (next.has(actionClass)) {
        next.delete(actionClass);
      } else {
        next.add(actionClass);
      }
      return next;
    });
  }

  isActionClassSelected(actionClass: CampaignActionClass): boolean {
    return this.selectedActionClasses().has(actionClass);
  }

  onBudgetInput(field: keyof CampaignBudgetDraft, event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.budgetDraft.update((draft) => ({ ...draft, [field]: Number.isFinite(value) ? value : 0 }));
  }

  async submitCampaign(): Promise<void> {
    this.validationError.set(null);
    const profileId = this.selectedProfileId();
    if (!profileId) {
      this.validationError.set('Select a profile.');
      return;
    }

    const label = this.label().trim();
    if (!label) {
      this.validationError.set('Campaign label is required.');
      return;
    }

    const allowedOrigins = this.originsText()
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (allowedOrigins.length === 0) {
      this.validationError.set('At least one allowed origin is required.');
      return;
    }

    // Defence in depth: even though the UI only offers safe action classes,
    // never forward anything outside the allowed set to the IPC call.
    const allowedActionClasses = Array.from(this.selectedActionClasses()).filter((actionClass) =>
      CAMPAIGN_ALLOWED_ACTION_CLASSES.includes(actionClass),
    );
    if (allowedActionClasses.length === 0) {
      this.validationError.set('At least one allowed action class is required.');
      return;
    }

    const draft = this.budgetDraft();
    const maxDurationMs = draft.durationHours * HOUR_MS;
    if (maxDurationMs > CAMPAIGN_MAX_DURATION_MS) {
      this.validationError.set(`Campaign duration cannot exceed ${this.maxDurationHours} hours.`);
      return;
    }
    if (maxDurationMs <= 0) {
      this.validationError.set('Campaign duration must be greater than zero.');
      return;
    }

    const created = await this.store.createCampaign({
      label,
      profileId,
      allowedOrigins,
      allowedActionClasses,
      budget: {
        maxActions: draft.maxActions,
        maxSubmits: draft.maxSubmits,
        maxNewAccounts: draft.maxNewAccounts,
        maxUploads: draft.maxUploads,
        maxDurationMs,
      },
    });
    if (created) {
      this.resetForm();
    }
  }

  async pause(campaignId: string): Promise<void> {
    await this.store.pauseCampaign(campaignId);
  }

  async resume(campaignId: string): Promise<void> {
    await this.store.resumeCampaign(campaignId);
  }

  async kill(campaignId: string): Promise<void> {
    await this.store.killCampaign(campaignId);
  }

  async toggleExpand(campaignId: string): Promise<void> {
    if (this.expandedCampaignId() === campaignId) {
      this.expandedCampaignId.set(null);
      return;
    }
    this.expandedCampaignId.set(campaignId);
    await this.store.loadCampaignDetail(campaignId);
  }

  onDeclarationHashInput(campaignId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.declarationHashDrafts.update((current) => ({ ...current, [campaignId]: value }));
  }

  declarationHashDraft(campaignId: string): string {
    return this.declarationHashDrafts()[campaignId] ?? '';
  }

  isDeclarationHashValid(campaignId: string): boolean {
    return DECLARATION_HASH_PATTERN.test(this.declarationHashDraft(campaignId).trim());
  }

  async approveDeclaration(campaignId: string): Promise<void> {
    const hash = this.declarationHashDraft(campaignId).trim().toLowerCase();
    if (!DECLARATION_HASH_PATTERN.test(hash)) {
      this.validationError.set('Declaration hash must be 64 hex characters.');
      return;
    }
    const approved = await this.store.approveDeclaration(campaignId, hash);
    if (approved) {
      this.declarationHashDrafts.update((current) => ({ ...current, [campaignId]: '' }));
    }
  }

  counterLabel(item: BrowserCampaignListItem): string {
    const counters = item.counters ?? { actions: 0, submits: 0, newAccounts: 0, uploads: 0 };
    const budget = item.campaign.budget;
    return [
      `actions ${counters.actions}/${budget.maxActions}`,
      `submits ${counters.submits}/${budget.maxSubmits}`,
      `new accounts ${counters.newAccounts}/${budget.maxNewAccounts}`,
      `uploads ${counters.uploads}/${budget.maxUploads}`,
    ].join(' · ');
  }

  formatExpiry(expiresAt: number): string {
    return new Date(expiresAt).toLocaleString();
  }

  private resetForm(): void {
    this.label.set('');
    this.originsText.set('');
    this.selectedActionClasses.set(new Set());
    this.budgetDraft.set(defaultBudgetDraft());
  }
}
