/**
 * Root Application Component
 */

import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ElectronIpcService } from './core/services/ipc';
import { PerfInstrumentationService } from './core/services/perf-instrumentation.service';
import { StressFixturesService } from './core/services/stress-fixtures.service';
import { WorkspaceBenchService, type WorkspaceBenchmarkHarness, type BenchmarkPresetName } from './core/services/workspace-bench.service';

declare global {
  interface Window {
    __perfService?: PerfInstrumentationService;
    __stressFixtures?: StressFixturesService;
    __workspaceBench?: WorkspaceBenchmarkHarness;
  }
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="app-container" [class.macos]="isMacOS">
      <!-- Draggable title bar area -->
      <div class="title-bar-drag-area" [class.windows]="!isMacOS"></div>

      <main class="app-main">
        <router-outlet />
      </main>
    </div>
  `,
  styles: [`
    .app-container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
      background: var(--bg-primary);
    }

    .app-container.macos {
      padding-top: 52px; /* Space for traffic lights (40px) + padding */
    }

    .title-bar-drag-area {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 52px;
      -webkit-app-region: drag;
      z-index: 1000;
    }

    .title-bar-drag-area.windows {
      height: 40px;
    }

    .app-main {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    .app-main > router-outlet {
      flex: 0 0 0;
      width: 0;
      height: 0;
      overflow: hidden;
      display: contents;
    }

    /* Ensure routed components fill the container */
    .app-main > * {
      flex: 1;
      display: flex;
      height: 100%;
      width: 100%;
    }
  `],
})
export class AppComponent implements OnInit {
  private ipcService = inject(ElectronIpcService);
  private perfService = inject(PerfInstrumentationService);
  private stressFixtures = inject(StressFixturesService);
  private workspaceBench = inject(WorkspaceBenchService);

  isMacOS = false;

  async ngOnInit(): Promise<void> {
    // Check platform - use Electron API if available, fallback to navigator
    const electronPlatform = this.ipcService.platform;
    if (electronPlatform && electronPlatform !== 'browser') {
      this.isMacOS = electronPlatform === 'darwin';
    } else {
      // Fallback detection for when Electron API isn't available
      this.isMacOS = navigator.platform?.toLowerCase().includes('mac') ?? false;
    }

    console.log('Platform detected:', this.isMacOS ? 'macOS' : 'other', '(source:', electronPlatform, ')');

    // Expose dev tools on window for console access (referenced in workspace-benchmarks.md)
    window.__perfService = this.perfService;
    window.__stressFixtures = this.stressFixtures;
    window.__workspaceBench = this.workspaceBench;

    // Signal app ready
    await this.ipcService.appReady();
    console.log('AI Orchestrator UI ready');
  }
}

// Re-export for consumers that import these types from app.component
export type { BenchmarkPresetName, WorkspaceBenchmarkHarness };
