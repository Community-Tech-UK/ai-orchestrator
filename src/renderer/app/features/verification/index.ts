/**
 * Verification Module Exports
 */

// Core Components
export { VerificationDashboardComponent } from './verification-dashboard.component';
export { AgentCardComponent } from './agent-card.component';
export { AgentConfigPanelComponent } from './agent-config-panel.component';
export { VerificationMonitorComponent } from './verification-monitor.component';
export { VerificationResultsComponent } from './verification-results.component';
export { ConsensusHeatmapComponent } from './consensus-heatmap.component';

// Settings Components
export { CliSettingsPanelComponent } from './cli-settings-panel.component';
export { ApiKeyManagerComponent } from './api-key-manager.component';
export { VerificationPreferencesComponent } from './verification-preferences.component';

// Export Panel
export { ExportPanelComponent, type ExportFormat } from './export-panel.component';

// CLI/Agent Components (new)
export { CliStatusIndicatorComponent } from './cli-status-indicator.component';
export { AgentCapabilityBadgesComponent } from './agent-capability-badges.component';
export { AgentPersonalityPickerComponent } from './agent-personality-picker.component';
export { CliDetectionPanelComponent } from './cli-detection-panel.component';
export { AgentSelectorComponent } from './agent-selector.component';

// Verification Components (new)
export { VerificationLauncherComponent } from './verification-launcher.component';
export { AgentResponseStreamComponent } from './agent-response-stream.component';
export { ProgressTrackerComponent } from './progress-tracker.component';
export { SynthesisViewerComponent } from './synthesis-viewer.component';
export { DebateRoundViewerComponent } from './debate-round-viewer.component';

// Services
export { VerificationService } from './services/verification.service';
export { AgentStreamService } from './services/agent-stream.service';
export { CliDetectionService } from './services/cli-detection.service';
