import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  type OnInit,
  inject,
  signal,
} from '@angular/core';
import type {
  LocalAiDiscoveredEndpoint,
  LocalAiIncident,
  LocalAiTargetStatus,
} from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { LocalAiIncidentPanelComponent } from './local-ai-incident-panel.component';
import { LocalAiEffectivenessPanelComponent } from './local-ai-effectiveness-panel.component';
import { LocalAiTargetCardComponent } from './local-ai-target-card.component';
import { LocalAiTargetSetupComponent } from './local-ai-target-setup.component';
import { LOCAL_AI_GUARD_CLOCK } from './local-ai-guard-clock';
import { LocalAiModalCoordinator } from './local-ai-modal-coordinator';

@Component({
  selector: 'app-local-ai-guard-page',
  standalone: true,
  imports: [
    LocalAiIncidentPanelComponent,
    LocalAiEffectivenessPanelComponent,
    LocalAiTargetCardComponent,
    LocalAiTargetSetupComponent,
  ],
  templateUrl: './local-ai-guard-page.component.html',
  styleUrl: './local-ai-guard-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [LocalAiModalCoordinator],
})
export class LocalAiGuardPageComponent implements OnInit {
  protected readonly store = inject(LocalAiGuardStore);
  private readonly clock = inject(LOCAL_AI_GUARD_CLOCK);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly modal = inject(LocalAiModalCoordinator);

  protected readonly now = signal(this.clock());
  protected readonly loading = signal(true);
  protected readonly showSetup = signal(false);
  protected readonly editingTargetId = signal<string | null>(null);
  protected readonly announcement = signal('');

  constructor() {
    const ticker = setInterval(() => this.now.set(this.clock()), 1_000);
    const unregisterFocusTargets = [
      this.modal.registerFocusTarget('next-incident-action', () =>
        this.host.nativeElement.querySelector<HTMLButtonElement>(
          '.incident-list .incident-actions button:not(:disabled)',
        )),
      this.modal.registerFocusTarget('next-target-action', () =>
        this.host.nativeElement.querySelector<HTMLButtonElement>(
          '.target-list .target-actions button:not(:disabled)',
        )),
      this.modal.registerFocusTarget('enrol-target', () =>
        this.host.nativeElement.querySelector<HTMLButtonElement>(
          '.health-header .button.primary',
        )),
      this.modal.registerFocusTarget('page-heading', () =>
        this.host.nativeElement.querySelector<HTMLElement>('h1')),
    ];
    this.destroyRef.onDestroy(() => {
      clearInterval(ticker);
      for (const unregister of unregisterFocusTargets) unregister();
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.store.initialize();
      await this.store.loadInventory();
    } finally {
      this.loading.set(false);
    }
  }

  protected async recover(): Promise<void> {
    if (this.store.operationKey() !== null) return;
    this.loading.set(true);
    try {
      await this.store.refresh();
      await this.store.loadInventory();
      this.announcement.set(
        this.store.hasAuthoritativeSnapshot()
          ? 'Local AI health status refreshed.'
          : 'Local AI health status remains unavailable.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  protected beginEnrolment(): void {
    this.editingTargetId.set(null);
    this.showSetup.set(true);
  }

  protected beginEdit(targetId: string): void {
    this.editingTargetId.set(targetId);
    this.showSetup.set(true);
  }

  protected closeSetup(): void {
    this.editingTargetId.set(null);
    this.showSetup.set(false);
  }

  protected setupSaved(): void {
    this.announcement.set(
      this.editingTargetId() ? 'Target changes saved.' : 'Local AI target enrolled.',
    );
    this.closeSetup();
  }

  protected retirementCompleted(): void {
    this.announcement.set('Target retired.');
  }

  protected targetDiscovery(targetId: string): LocalAiDiscoveredEndpoint | null {
    return this.store.discoveries()
      .find((endpoint) => endpoint.enrolledTargetId === targetId) ?? null;
  }

  protected editingDiscovery(): LocalAiDiscoveredEndpoint | null {
    const targetId = this.editingTargetId();
    if (!targetId) return null;
    const discovered = this.targetDiscovery(targetId);
    if (discovered) return discovered;
    const target = this.store.knownTarget(targetId);
    if (!target) return null;
    return {
      identity: {
        location: target.location,
        provider: target.provider,
        endpointId: target.endpointId,
        baseUrl: target.baseUrl,
      },
      label: target.label,
      models: target.expectedModels.map((model) => model.modelId),
      healthy: false,
      enrolledTargetId: target.id,
    };
  }

  protected incidentsFor(targetId: string): LocalAiIncident[] {
    return this.store.activeIncidents().filter((incident) => incident.targetId === targetId);
  }

  protected automaticRepairEnabled(targetId: string): boolean {
    return this.store.knownTarget?.(targetId)?.recovery.automatic ?? false;
  }

  protected targetLifecycle(targetId: string): LocalAiTargetStatus['lifecycle'] {
    return this.store.targets().find((target) => target.targetId === targetId)?.lifecycle
      ?? 'enrolled';
  }
}
