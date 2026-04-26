/**
 * Agent Selector Component - Dropdown to select agent mode
 *
 * Displays available agent profiles (Build, Plan, Review) with colors
 * and allows switching between them for new instances.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  inject,
  output,
  signal,
} from '@angular/core';
import { AgentStore } from '../../core/state/agent.store';
import type { AgentProfile } from '../../../../shared/types/agent.types';

@Component({
  selector: 'app-agent-selector',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="agent-selector">
      <button
        class="selected-agent"
        [style.border-color]="selectedAgent().color"
        (click)="toggleDropdown()"
        title="Select agent mode for new instances"
      >
        <span class="agent-icon" [style.color]="selectedAgent().color">
          @switch (selectedAgent().icon) {
            @case ('hammer') {
              <span class="icon-symbol">&#9874;</span>
            }
            @case ('map') {
              <span class="icon-symbol">&#128506;</span>
            }
            @case ('eye') {
              <span class="icon-symbol">&#128065;</span>
            }
            @default {
              <span class="icon-symbol">&#9679;</span>
            }
          }
        </span>
        <span class="agent-name">{{ selectedAgent().name }}</span>
        <span class="dropdown-arrow">{{
          isOpen() ? '&#9650;' : '&#9660;'
        }}</span>
      </button>

      @if (isOpen()) {
        <div
          class="dropdown-menu"
          (click)="$event.stopPropagation()"
          (keydown.enter)="$event.stopPropagation()"
          (keydown.space)="$event.stopPropagation()"
          role="menu"
          tabindex="-1"
        >
          @for (agent of allAgents(); track agent.id) {
            <button
              class="agent-option"
              [class.selected]="agent.id === selectedAgent().id"
              [style.border-left-color]="agent.color"
              (click)="selectAgent(agent)"
            >
              <span class="agent-icon" [style.color]="agent.color">
                @switch (agent.icon) {
                  @case ('hammer') {
                    <span class="icon-symbol">&#9874;</span>
                  }
                  @case ('map') {
                    <span class="icon-symbol">&#128506;</span>
                  }
                  @case ('eye') {
                    <span class="icon-symbol">&#128065;</span>
                  }
                  @default {
                    <span class="icon-symbol">&#9679;</span>
                  }
                }
              </span>
              <div class="agent-info">
                <span class="agent-name">{{ agent.name }}</span>
                <span class="agent-description">{{ agent.description }}</span>
              </div>
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        position: relative;
        display: inline-block;
      }

      .agent-selector {
        position: relative;
        z-index: 100;
      }

      .selected-agent {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        height: 36px;
        box-sizing: border-box;
        background: var(--bg-secondary);
        border: 1px solid;
        border-radius: 6px;
        color: var(--text-primary);
        cursor: pointer;
        transition: all var(--transition-fast);
        font-size: 13px;
      }

      .selected-agent:hover {
        background: var(--bg-tertiary);
      }

      .agent-icon {
        font-size: 14px;
      }

      .icon-symbol {
        display: inline-block;
        width: 16px;
        text-align: center;
      }

      .agent-name {
        font-weight: 500;
      }

      .dropdown-arrow {
        font-size: 10px;
        opacity: 0.6;
      }

      .dropdown-menu {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        min-width: 220px;
        margin-top: 4px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        box-shadow: var(--shadow-lg);
        overflow: hidden;
        z-index: 101;
      }

      .agent-option {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 10px 12px;
        background: transparent;
        border: none;
        border-left: 3px solid transparent;
        color: var(--text-primary);
        cursor: pointer;
        text-align: left;
        transition: all var(--transition-fast);
      }

      .agent-option:hover {
        background: var(--bg-tertiary);
      }

      .agent-option.selected {
        background: var(--bg-tertiary);
      }

      .agent-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .agent-info .agent-name {
        font-size: 13px;
      }

      .agent-description {
        font-size: 11px;
        color: var(--text-secondary);
      }
    `
  ]
})
export class AgentSelectorComponent {
  private agentStore = inject(AgentStore);
  private elementRef = inject(ElementRef<HTMLElement>);

  // Outputs
  agentSelected = output<AgentProfile>();

  // Local state
  protected isOpen = signal(false);

  // From store
  protected selectedAgent = this.agentStore.selectedAgent;
  protected allAgents = this.agentStore.allAgents;

  toggleDropdown(): void {
    this.isOpen.update((v) => !v);
  }

  closeDropdown(): void {
    this.isOpen.set(false);
  }

  selectAgent(agent: AgentProfile): void {
    this.agentStore.selectAgent(agent.id);
    this.agentSelected.emit(agent);
    this.closeDropdown();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.isOpen()) return;
    const target = event.target as Node | null;
    if (target && !this.elementRef.nativeElement.contains(target)) {
      this.closeDropdown();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen()) {
      this.closeDropdown();
    }
  }
}
