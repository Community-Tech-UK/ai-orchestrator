/**
 * Keybinding Service - Handle keyboard shortcuts
 *
 * Features:
 * - Global and context-specific keybindings
 * - Leader key sequences
 * - Customizable bindings
 * - Platform-aware modifier handling
 */

import { Injectable, NgZone, signal, computed, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  KeyBinding,
  KeyCombo,
  KeybindingContext,
  DEFAULT_KEYBINDINGS,
  KeybindingCustomization,
  matchesKeyCombo,
  formatKeyBinding,
} from '../../../../shared/types/keybinding.types';

export interface KeybindingEvent {
  binding: KeyBinding;
  event: KeyboardEvent;
}

type KeybindingHandler = (event: KeybindingEvent) => void;

@Injectable({
  providedIn: 'root',
})
export class KeybindingService {
  private document = inject(DOCUMENT);
  private zone = inject(NgZone);

  // State
  private bindings = signal<KeyBinding[]>([...DEFAULT_KEYBINDINGS]);
  private customizations = signal<KeybindingCustomization[]>([]);
  private currentContext = signal<KeybindingContext>('global');
  private handlers = new Map<string, KeybindingHandler[]>();
  private enabled = signal(true);

  // Leader key state
  private leaderActive = signal(false);
  private leaderSequence = signal<KeyCombo[]>([]);
  private leaderTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly LEADER_TIMEOUT_MS = 1000;

  // Platform detection
  readonly isMac = this.document.defaultView?.navigator.platform.includes('Mac') ?? false;

  // Computed
  readonly allBindings = computed(() => {
    const base = this.bindings();
    const customs = this.customizations();

    // Apply customizations
    return base.map((binding) => {
      const custom = customs.find((c) => c.id === binding.id);
      if (custom) {
        return { ...binding, keys: custom.keys };
      }
      return binding;
    });
  });

  readonly bindingsByCategory = computed(() => {
    const bindings = this.allBindings();
    const categories = new Map<string, KeyBinding[]>();

    for (const binding of bindings) {
      const category = binding.category || 'Other';
      if (!categories.has(category)) {
        categories.set(category, []);
      }
      categories.get(category)!.push(binding);
    }

    return categories;
  });

  constructor() {
    this.setupGlobalListener();
  }

  /**
   * Setup the global keyboard event listener
   */
  private setupGlobalListener(): void {
    // Run outside Angular zone for performance
    this.zone.runOutsideAngular(() => {
      this.document.addEventListener('keydown', (event) => {
        if (!this.enabled()) return;
        this.handleKeyDown(event);
      });
    });
  }

  /**
   * Handle a keydown event
   */
  private handleKeyDown(event: KeyboardEvent): void {
    // Skip if target is an input and we're not in input context
    const isInputElement =
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      (event.target as HTMLElement)?.isContentEditable;

    const context = this.currentContext();
    const bindings = this.allBindings();

    // Find matching binding
    for (const binding of bindings) {
      // Check context
      if (binding.context && binding.context !== 'global') {
        if (binding.context !== context) continue;
      }

      // If we're in an input and the binding is global without requiring modifiers,
      // skip to avoid interfering with typing
      if (isInputElement && binding.context === 'global') {
        const keys = Array.isArray(binding.keys) ? binding.keys[0] : binding.keys;
        if (keys.modifiers.length === 0 && keys.key.length === 1) {
          continue;
        }
      }

      // Check if this is a sequence
      if (Array.isArray(binding.keys)) {
        if (this.handleSequence(event, binding)) {
          return;
        }
      } else {
        if (matchesKeyCombo(event, binding.keys)) {
          event.preventDefault();
          event.stopPropagation();
          this.triggerBinding(binding, event);
          return;
        }
      }
    }

    // Reset leader sequence if no match
    if (this.leaderActive()) {
      this.resetLeaderSequence();
    }
  }

  /**
   * Handle a key sequence (leader key pattern)
   */
  private handleSequence(event: KeyboardEvent, binding: KeyBinding): boolean {
    const sequence = binding.keys as KeyCombo[];
    const currentSeq = this.leaderSequence();

    // Check if this key matches the next expected key in sequence
    const nextIndex = currentSeq.length;
    if (nextIndex >= sequence.length) return false;

    const expectedCombo = sequence[nextIndex];
    if (!matchesKeyCombo(event, expectedCombo)) {
      return false;
    }

    // Key matches, add to sequence
    event.preventDefault();
    event.stopPropagation();

    const newSeq = [...currentSeq, expectedCombo];
    this.leaderSequence.set(newSeq);
    this.leaderActive.set(true);

    // Reset timeout
    if (this.leaderTimeout) {
      clearTimeout(this.leaderTimeout);
    }
    this.leaderTimeout = setTimeout(() => {
      this.resetLeaderSequence();
    }, this.LEADER_TIMEOUT_MS);

    // Check if sequence is complete
    if (newSeq.length === sequence.length) {
      this.resetLeaderSequence();
      this.triggerBinding(binding, event);
      return true;
    }

    return true;
  }

  /**
   * Reset the leader sequence state
   */
  private resetLeaderSequence(): void {
    this.leaderActive.set(false);
    this.leaderSequence.set([]);
    if (this.leaderTimeout) {
      clearTimeout(this.leaderTimeout);
      this.leaderTimeout = null;
    }
  }

  /**
   * Trigger a keybinding
   */
  private triggerBinding(binding: KeyBinding, event: KeyboardEvent): void {
    const handlers = this.handlers.get(binding.action) || [];
    const bindingEvent: KeybindingEvent = { binding, event };

    // Run handlers in Angular zone
    this.zone.run(() => {
      for (const handler of handlers) {
        handler(bindingEvent);
      }
    });
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Register a handler for an action
   */
  onAction(action: string, handler: KeybindingHandler): () => void {
    if (!this.handlers.has(action)) {
      this.handlers.set(action, []);
    }
    this.handlers.get(action)!.push(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.handlers.get(action);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index !== -1) {
          handlers.splice(index, 1);
        }
      }
    };
  }

  /**
   * Set the current keybinding context
   */
  setContext(context: KeybindingContext): void {
    this.currentContext.set(context);
  }

  /**
   * Get the current context
   */
  getContext(): KeybindingContext {
    return this.currentContext();
  }

  /**
   * Enable/disable keybindings
   */
  setEnabled(enabled: boolean): void {
    this.enabled.set(enabled);
  }

  /**
   * Check if keybindings are enabled
   */
  isEnabled(): boolean {
    return this.enabled();
  }

  /**
   * Get binding by ID
   */
  getBinding(id: string): KeyBinding | undefined {
    return this.allBindings().find((b) => b.id === id);
  }

  /**
   * Get binding by action
   */
  getBindingByAction(action: string): KeyBinding | undefined {
    return this.allBindings().find((b) => b.action === action);
  }

  /**
   * Format a binding for display
   */
  formatBinding(binding: KeyBinding): string {
    return formatKeyBinding(binding, this.isMac);
  }

  /**
   * Format a binding by action
   */
  formatBindingByAction(action: string): string {
    const binding = this.getBindingByAction(action);
    return binding ? this.formatBinding(binding) : '';
  }

  /**
   * Customize a keybinding
   */
  customizeBinding(id: string, keys: KeyCombo | KeyCombo[]): void {
    const binding = this.getBinding(id);
    if (!binding || binding.customizable === false) {
      console.warn(`Cannot customize binding: ${id}`);
      return;
    }

    const customs = [...this.customizations()];
    const existing = customs.findIndex((c) => c.id === id);

    if (existing !== -1) {
      customs[existing] = { id, keys };
    } else {
      customs.push({ id, keys });
    }

    this.customizations.set(customs);
  }

  /**
   * Reset a customized binding to default
   */
  resetBinding(id: string): void {
    const customs = this.customizations().filter((c) => c.id !== id);
    this.customizations.set(customs);
  }

  /**
   * Reset all customizations
   */
  resetAllBindings(): void {
    this.customizations.set([]);
  }

  /**
   * Load customizations from settings
   */
  loadCustomizations(customizations: KeybindingCustomization[]): void {
    this.customizations.set(customizations);
  }

  /**
   * Get current customizations for saving
   */
  getCustomizations(): KeybindingCustomization[] {
    return this.customizations();
  }

  /**
   * Add a new custom binding
   */
  addBinding(binding: KeyBinding): void {
    const bindings = [...this.bindings()];
    // Remove existing binding with same ID
    const existing = bindings.findIndex((b) => b.id === binding.id);
    if (existing !== -1) {
      bindings[existing] = binding;
    } else {
      bindings.push(binding);
    }
    this.bindings.set(bindings);
  }

  /**
   * Remove a custom binding
   */
  removeBinding(id: string): void {
    const bindings = this.bindings().filter((b) => b.id !== id);
    this.bindings.set(bindings);
  }
}
