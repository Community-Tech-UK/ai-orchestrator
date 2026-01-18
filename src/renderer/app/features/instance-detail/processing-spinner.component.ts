/**
 * Processing Spinner Component - 4x4 grid animated spinner
 *
 * Features:
 * - 4x4 grid of squares that pulse in sequence
 * - Randomized animation delays for organic feel
 * - Matches Claude Code's processing indicator style
 */

import { Component, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-processing-spinner',
  standalone: true,
  template: `
    <div class="spinner-container">
      <div class="spinner-grid">
        @for (i of squares; track i) {
          <div
            class="spinner-square"
            [style.animationDelay]="getDelay(i)"
          ></div>
        }
      </div>
    </div>
  `,
  styles: [`
    .spinner-container {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .spinner-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 3px;
      width: 20px;
      height: 20px;
    }

    .spinner-square {
      width: 4px;
      height: 4px;
      border-radius: 1px;
      background-color: var(--primary-color, #3b82f6);
      animation: pulse 1.2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 0.3;
        transform: scale(0.8);
      }
      50% {
        opacity: 1;
        transform: scale(1);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProcessingSpinnerComponent {
  // 16 squares for 4x4 grid
  readonly squares = Array.from({ length: 16 }, (_, i) => i);

  // Pre-computed random delays for organic feel
  private readonly delays: number[];

  constructor() {
    // Generate random delays between 0 and 1s for each square
    // Use a seeded pattern for consistency
    this.delays = this.squares.map((i) => {
      // Create a wave pattern with some randomness
      const row = Math.floor(i / 4);
      const col = i % 4;
      const base = (row + col) * 0.1; // Wave effect
      const random = Math.sin(i * 7.3) * 0.15; // Pseudo-random variation
      return (base + random + 0.6) % 1.2; // Keep within animation duration
    });
  }

  getDelay(index: number): string {
    return `${this.delays[index].toFixed(2)}s`;
  }
}
