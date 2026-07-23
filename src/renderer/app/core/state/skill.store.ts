/**
 * Skill Store - State management for skills integration with command palette
 */

import { Injectable, inject, signal, computed } from '@angular/core';
import { OrchestrationIpcService } from '../services/ipc/orchestration-ipc.service';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import { ToastService } from '../services/toast.service';
import type { SkillBundle, SkillMatch } from '../../../../shared/types/skill.types';
import type {
  SkillActivationRecord,
  SkillControlMode,
  SkillControlRecord,
} from '../../../../shared/types/skill-observability.types';

const MAX_ACTIVATION_RECORDS = 300;
/** Suppress repeat activation toasts for the same skill+instance within this window. */
const TOAST_COOLDOWN_MS = 5 * 60_000;

export interface SkillCommand {
  id: string;
  name: string;
  description: string;
  trigger: string;
  category?: string;
  icon?: string;
  isSkill: true;
}

@Injectable({ providedIn: 'root' })
export class SkillStore {
  private ipcService = inject(OrchestrationIpcService);
  private electronIpc = inject(ElectronIpcService);
  private toast = inject(ToastService);

  // State
  private _skills = signal<SkillBundle[]>([]);
  private _loading = signal(false);
  private _error = signal<string | null>(null);
  private _activeSkills = signal<Set<string>>(new Set());

  // Observability state
  private _activations = signal<readonly SkillActivationRecord[]>([]);
  private _controls = signal<ReadonlyMap<string, SkillControlRecord>>(new Map());
  private unsubscribeDelta: (() => void) | null = null;
  private observabilityInitialized = false;
  private lastToastAt = new Map<string, number>();

  // Selectors
  skills = this._skills.asReadonly();
  loading = this._loading.asReadonly();
  error = this._error.asReadonly();
  activeSkills = this._activeSkills.asReadonly();
  activations = this._activations.asReadonly();
  controls = this._controls.asReadonly();

  /**
   * Get skills formatted as commands for the command palette
   */
  skillCommands = computed((): SkillCommand[] => {
    return this._skills().flatMap(skill =>
      skill.metadata.triggers.map(trigger => ({
        id: `skill:${skill.id}:${trigger}`,
        name: trigger.replace(/^\//, ''), // Remove leading slash if present
        description: skill.metadata.description,
        trigger,
        category: skill.metadata.category,
        icon: skill.metadata.icon,
        isSkill: true as const,
      }))
    );
  });

  /**
   * Get count of active skills
   */
  activeSkillCount = computed(() => this._activeSkills().size);

  // ============ Observability (activation feed + kill-switch) ============

  /**
   * Start the live activation feed. Idempotent; call once at app startup.
   */
  initObservability(): void {
    if (this.observabilityInitialized) return;
    this.observabilityInitialized = true;
    const api = this.electronIpc.getApi();
    if (api?.onSkillActivationDelta) {
      this.unsubscribeDelta = api.onSkillActivationDelta((raw) => {
        this.onActivationDelta(raw as SkillActivationRecord);
      });
    }
    void this.refreshActivations();
    void this.refreshControls();
  }

  disposeObservability(): void {
    this.unsubscribeDelta?.();
    this.unsubscribeDelta = null;
    this.observabilityInitialized = false;
  }

  private onActivationDelta(activation: SkillActivationRecord): void {
    this._activations.update((list) =>
      [activation, ...list].slice(0, MAX_ACTIVATION_RECORDS)
    );
    if (!activation.autoSelected) return; // explicit loads need no announcement

    const cooldownKey = `${activation.skillName}::${activation.instanceId ?? ''}`;
    const now = Date.now();
    const last = this.lastToastAt.get(cooldownKey) ?? 0;
    if (now - last < TOAST_COOLDOWN_MS) return;
    this.lastToastAt.set(cooldownKey, now);

    const reason = activation.matchedTrigger
      ? `matched "${activation.matchedTrigger}"`
      : `semantic match ${activation.matchScore !== null ? activation.matchScore.toFixed(2) : ''}`.trim();
    this.toast.show(`Skill ${activation.skillName} activated — ${reason}`);
  }

  /** Activations recorded for one instance's current session, newest first. */
  activationsForInstance(instanceId: string): SkillActivationRecord[] {
    return this._activations().filter((a) => a.instanceId === instanceId);
  }

  async refreshActivations(): Promise<void> {
    const response = await this.ipcService.skillsActivationsRecent({ limit: MAX_ACTIVATION_RECORDS });
    if (response.success && Array.isArray(response.data)) {
      this._activations.set(response.data as SkillActivationRecord[]);
    }
  }

  async refreshControls(): Promise<void> {
    const response = await this.ipcService.skillsListControls();
    if (response.success && Array.isArray(response.data)) {
      const map = new Map<string, SkillControlRecord>();
      for (const control of response.data as SkillControlRecord[]) {
        map.set(control.skillName, control);
      }
      this._controls.set(map);
    }
  }

  /** The persisted control mode for a skill, if one has been set. */
  controlModeFor(skillName: string): SkillControlMode | null {
    return this._controls().get(skillName)?.mode ?? null;
  }

  async setSkillControl(
    skillName: string,
    mode: SkillControlMode,
    reason?: string
  ): Promise<boolean> {
    const response = await this.ipcService.skillsSetControl(skillName, mode, reason);
    if (!response.success) {
      this.toast.show(`Could not update skill "${skillName}"`, 'error');
      return false;
    }
    const control = response.data as SkillControlRecord;
    this._controls.update((map) => {
      const next = new Map(map);
      next.set(control.skillName, control);
      return next;
    });
    return true;
  }

  /**
   * Discover and load available skills
   */
  async discoverSkills(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);

    try {
      const response = await this.ipcService.skillsDiscover();
      if (response.success && 'data' in response && response.data) {
        this._skills.set(response.data as SkillBundle[]);
      } else {
        const errorMsg = 'error' in response ? response.error?.message : 'Failed to discover skills';
        this._error.set(errorMsg || 'Failed to discover skills');
      }
    } catch (err) {
      this._error.set((err as Error).message);
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Match input text against skill triggers
   */
  async matchSkill(text: string): Promise<SkillMatch | null> {
    try {
      const response = await this.ipcService.skillsMatch(text);
      if (response.success && 'data' in response && response.data) {
        return response.data as SkillMatch;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Load a skill (activate it)
   */
  async loadSkill(skillId: string): Promise<boolean> {
    try {
      const response = await this.ipcService.skillsLoad(skillId);
      if (response.success) {
        this._activeSkills.update(set => {
          const newSet = new Set(set);
          newSet.add(skillId);
          return newSet;
        });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Unload a skill (deactivate it)
   */
  async unloadSkill(skillId: string): Promise<boolean> {
    try {
      const response = await this.ipcService.skillsUnload(skillId);
      if (response.success) {
        this._activeSkills.update(set => {
          const newSet = new Set(set);
          newSet.delete(skillId);
          return newSet;
        });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get a skill by ID
   */
  getSkillById(skillId: string): SkillBundle | undefined {
    return this._skills().find(s => s.id === skillId);
  }

  /**
   * Get skills by category
   */
  getSkillsByCategory(category: string): SkillBundle[] {
    return this._skills().filter(s => s.metadata.category === category);
  }

  /**
   * Check if a skill is active
   */
  isSkillActive(skillId: string): boolean {
    return this._activeSkills().has(skillId);
  }

  /**
   * Get active skill bundles
   */
  getActiveSkillBundles(): SkillBundle[] {
    const activeIds = this._activeSkills();
    return this._skills().filter(s => activeIds.has(s.id));
  }
}
