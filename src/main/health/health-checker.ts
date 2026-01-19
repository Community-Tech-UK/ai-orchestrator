/**
 * Health Checker Service
 *
 * Monitor system health and component status:
 * - API connectivity
 * - MCP server health
 * - Memory usage
 * - Disk space
 * - Instance health
 * - Rate limiting status
 */

import { EventEmitter } from 'events';
import Anthropic from '@anthropic-ai/sdk';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
export type ComponentType = 'api' | 'mcp' | 'memory' | 'disk' | 'instance' | 'network' | 'custom';

export interface ComponentHealth {
  name: string;
  type: ComponentType;
  status: HealthStatus;
  message?: string;
  lastCheck: number;
  latency?: number;
  metadata?: Record<string, unknown>;
}

export interface SystemHealth {
  overall: HealthStatus;
  components: ComponentHealth[];
  timestamp: number;
  uptime: number;
}

export interface HealthCheckConfig {
  /** Check interval in milliseconds */
  checkInterval: number;
  /** Timeout for individual checks */
  checkTimeout: number;
  /** Enable automatic checks */
  autoCheck: boolean;
  /** Thresholds for degraded status */
  thresholds: HealthThresholds;
}

export interface HealthThresholds {
  /** Memory usage percentage for degraded */
  memoryDegraded: number;
  /** Memory usage percentage for unhealthy */
  memoryUnhealthy: number;
  /** Disk usage percentage for degraded */
  diskDegraded: number;
  /** Disk usage percentage for unhealthy */
  diskUnhealthy: number;
  /** API latency (ms) for degraded */
  apiLatencyDegraded: number;
  /** API latency (ms) for unhealthy */
  apiLatencyUnhealthy: number;
}

export interface HealthCheckResult {
  component: string;
  status: HealthStatus;
  latency: number;
  message?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type HealthCheckFn = () => Promise<HealthCheckResult>;

const DEFAULT_CONFIG: HealthCheckConfig = {
  checkInterval: 60000, // 1 minute
  checkTimeout: 10000, // 10 seconds
  autoCheck: true,
  thresholds: {
    memoryDegraded: 70,
    memoryUnhealthy: 90,
    diskDegraded: 80,
    diskUnhealthy: 95,
    apiLatencyDegraded: 2000,
    apiLatencyUnhealthy: 5000,
  },
};

export class HealthChecker extends EventEmitter {
  private static instance: HealthChecker | null = null;
  private config: HealthCheckConfig;
  private anthropic: Anthropic | null = null;
  private customChecks: Map<string, HealthCheckFn> = new Map();
  private componentHealth: Map<string, ComponentHealth> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;
  private startTime: number = Date.now();

  private constructor() {
    super();
    this.config = { ...DEFAULT_CONFIG };
  }

  static getInstance(): HealthChecker {
    if (!HealthChecker.instance) {
      HealthChecker.instance = new HealthChecker();
    }
    return HealthChecker.instance;
  }

  /**
   * Initialize with API key
   */
  initialize(apiKey?: string): void {
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
    }

    if (this.config.autoCheck) {
      this.startAutoCheck();
    }

    this.emit('initialized');
  }

  /**
   * Update configuration
   */
  configure(config: Partial<HealthCheckConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart auto-check if interval changed
    if (this.checkInterval) {
      this.stopAutoCheck();
      if (this.config.autoCheck) {
        this.startAutoCheck();
      }
    }

    this.emit('config-updated', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): HealthCheckConfig {
    return { ...this.config };
  }

  /**
   * Register a custom health check
   */
  registerCheck(name: string, check: HealthCheckFn): void {
    this.customChecks.set(name, check);
    this.emit('check-registered', { name });
  }

  /**
   * Unregister a custom health check
   */
  unregisterCheck(name: string): boolean {
    const removed = this.customChecks.delete(name);
    if (removed) {
      this.componentHealth.delete(name);
      this.emit('check-unregistered', { name });
    }
    return removed;
  }

  /**
   * Start automatic health checks
   */
  startAutoCheck(): void {
    if (this.checkInterval) {
      this.stopAutoCheck();
    }

    this.checkInterval = setInterval(() => {
      this.checkAll().catch(err => {
        this.emit('error', { error: err.message });
      });
    }, this.config.checkInterval);

    // Run initial check
    this.checkAll().catch(err => {
      this.emit('error', { error: err.message });
    });

    this.emit('auto-check-started');
  }

  /**
   * Stop automatic health checks
   */
  stopAutoCheck(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      this.emit('auto-check-stopped');
    }
  }

  /**
   * Run all health checks
   */
  async checkAll(): Promise<SystemHealth> {
    const checks: Promise<void>[] = [];

    // Built-in checks
    checks.push(this.checkApi());
    checks.push(this.checkMemory());
    checks.push(this.checkDisk());

    // Custom checks
    for (const [name, check] of this.customChecks) {
      checks.push(this.runCheck(name, 'custom', check));
    }

    await Promise.allSettled(checks);

    const health = this.getHealth();
    this.emit('health-checked', health);

    return health;
  }

  /**
   * Get current system health
   */
  getHealth(): SystemHealth {
    const components = Array.from(this.componentHealth.values());
    const overall = this.calculateOverallStatus(components);

    return {
      overall,
      components,
      timestamp: Date.now(),
      uptime: Date.now() - this.startTime,
    };
  }

  /**
   * Get specific component health
   */
  getComponentHealth(name: string): ComponentHealth | undefined {
    return this.componentHealth.get(name);
  }

  /**
   * Check API connectivity
   */
  private async checkApi(): Promise<void> {
    const name = 'anthropic-api';
    const startTime = Date.now();

    if (!this.anthropic) {
      this.updateComponentHealth(name, 'api', {
        status: 'unknown',
        message: 'API client not initialized',
        latency: 0,
      });
      return;
    }

    try {
      // Use a simple models list call to check connectivity
      await Promise.race([
        this.anthropic.models.list(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), this.config.checkTimeout)
        ),
      ]);

      const latency = Date.now() - startTime;
      let status: HealthStatus = 'healthy';

      if (latency > this.config.thresholds.apiLatencyUnhealthy) {
        status = 'unhealthy';
      } else if (latency > this.config.thresholds.apiLatencyDegraded) {
        status = 'degraded';
      }

      this.updateComponentHealth(name, 'api', {
        status,
        latency,
        message: `API responding in ${latency}ms`,
      });
    } catch (error) {
      const latency = Date.now() - startTime;
      const message = (error as Error).message;

      // Check for rate limiting
      if (message.includes('rate') || message.includes('429')) {
        this.updateComponentHealth(name, 'api', {
          status: 'degraded',
          latency,
          message: 'Rate limited',
          metadata: { rateLimited: true },
        });
      } else {
        this.updateComponentHealth(name, 'api', {
          status: 'unhealthy',
          latency,
          message: `API error: ${message}`,
        });
      }
    }
  }

  /**
   * Check memory usage
   */
  private async checkMemory(): Promise<void> {
    const name = 'memory';
    const memUsage = process.memoryUsage();

    const heapUsedMB = memUsage.heapUsed / 1024 / 1024;
    const heapTotalMB = memUsage.heapTotal / 1024 / 1024;
    const usagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    let status: HealthStatus = 'healthy';
    if (usagePercent > this.config.thresholds.memoryUnhealthy) {
      status = 'unhealthy';
    } else if (usagePercent > this.config.thresholds.memoryDegraded) {
      status = 'degraded';
    }

    this.updateComponentHealth(name, 'memory', {
      status,
      message: `${heapUsedMB.toFixed(1)}MB / ${heapTotalMB.toFixed(1)}MB (${usagePercent.toFixed(1)}%)`,
      metadata: {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        rss: memUsage.rss,
        usagePercent,
      },
    });
  }

  /**
   * Check disk space (for data directory)
   */
  private async checkDisk(): Promise<void> {
    const name = 'disk';

    try {
      // Use Node's built-in fs for disk check
      const { promises: fs } = require('fs');
      const os = require('os');
      const path = require('path');

      const dataDir = path.join(os.homedir(), '.claude-orchestrator');

      // Create directory if it doesn't exist
      try {
        await fs.mkdir(dataDir, { recursive: true });
      } catch {
        // Ignore if exists
      }

      // Check available space (platform-dependent)
      // For simplicity, we'll just check if we can write
      const testFile = path.join(dataDir, '.health-check');
      await fs.writeFile(testFile, 'test');
      await fs.unlink(testFile);

      this.updateComponentHealth(name, 'disk', {
        status: 'healthy',
        message: 'Disk writable',
        metadata: { dataDir },
      });
    } catch (error) {
      this.updateComponentHealth(name, 'disk', {
        status: 'unhealthy',
        message: `Disk error: ${(error as Error).message}`,
      });
    }
  }

  /**
   * Run a custom health check
   */
  private async runCheck(name: string, type: ComponentType, check: HealthCheckFn): Promise<void> {
    const startTime = Date.now();

    try {
      const result = await Promise.race([
        check(),
        new Promise<HealthCheckResult>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), this.config.checkTimeout)
        ),
      ]);

      this.updateComponentHealth(name, type, {
        status: result.status,
        latency: result.latency || (Date.now() - startTime),
        message: result.message,
        metadata: result.metadata,
      });
    } catch (error) {
      this.updateComponentHealth(name, type, {
        status: 'unhealthy',
        latency: Date.now() - startTime,
        message: `Check failed: ${(error as Error).message}`,
      });
    }
  }

  /**
   * Update component health
   */
  private updateComponentHealth(
    name: string,
    type: ComponentType,
    update: Partial<ComponentHealth>
  ): void {
    const existing = this.componentHealth.get(name);
    const previousStatus = existing?.status;

    const health: ComponentHealth = {
      name,
      type,
      status: update.status || 'unknown',
      message: update.message,
      lastCheck: Date.now(),
      latency: update.latency,
      metadata: update.metadata,
    };

    this.componentHealth.set(name, health);

    // Emit status change event
    if (previousStatus !== health.status) {
      this.emit('status-changed', {
        component: name,
        previousStatus,
        newStatus: health.status,
      });

      // Emit specific events for unhealthy transitions
      if (health.status === 'unhealthy') {
        this.emit('component-unhealthy', health);
      } else if (previousStatus === 'unhealthy' && health.status === 'healthy') {
        this.emit('component-recovered', health);
      }
    }
  }

  /**
   * Calculate overall system status
   */
  private calculateOverallStatus(components: ComponentHealth[]): HealthStatus {
    if (components.length === 0) return 'unknown';

    const statuses = components.map(c => c.status);

    if (statuses.includes('unhealthy')) {
      return 'unhealthy';
    }

    if (statuses.includes('degraded')) {
      return 'degraded';
    }

    if (statuses.every(s => s === 'healthy')) {
      return 'healthy';
    }

    return 'unknown';
  }

  /**
   * Check MCP server health
   */
  async checkMcpServer(serverName: string, checkFn: () => Promise<boolean>): Promise<void> {
    const name = `mcp-${serverName}`;
    const startTime = Date.now();

    try {
      const healthy = await Promise.race([
        checkFn(),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), this.config.checkTimeout)
        ),
      ]);

      const latency = Date.now() - startTime;

      this.updateComponentHealth(name, 'mcp', {
        status: healthy ? 'healthy' : 'unhealthy',
        latency,
        message: healthy ? `Server responding in ${latency}ms` : 'Server not responding',
      });
    } catch (error) {
      this.updateComponentHealth(name, 'mcp', {
        status: 'unhealthy',
        latency: Date.now() - startTime,
        message: `Server error: ${(error as Error).message}`,
      });
    }
  }

  /**
   * Check instance health
   */
  checkInstance(
    instanceId: string,
    status: {
      active: boolean;
      responding: boolean;
      tokensUsed?: number;
      errorCount?: number;
    }
  ): void {
    const name = `instance-${instanceId}`;

    let healthStatus: HealthStatus = 'healthy';
    let message = 'Instance active and responding';

    if (!status.active) {
      healthStatus = 'unknown';
      message = 'Instance not active';
    } else if (!status.responding) {
      healthStatus = 'unhealthy';
      message = 'Instance not responding';
    } else if (status.errorCount && status.errorCount > 5) {
      healthStatus = 'degraded';
      message = `High error count: ${status.errorCount}`;
    }

    this.updateComponentHealth(name, 'instance', {
      status: healthStatus,
      message,
      metadata: {
        active: status.active,
        responding: status.responding,
        tokensUsed: status.tokensUsed,
        errorCount: status.errorCount,
      },
    });
  }

  /**
   * Get health summary as string
   */
  getSummary(): string {
    const health = this.getHealth();
    const lines: string[] = [];

    lines.push(`Overall: ${health.overall.toUpperCase()}`);
    lines.push(`Uptime: ${Math.floor(health.uptime / 1000 / 60)} minutes`);
    lines.push('');
    lines.push('Components:');

    for (const component of health.components) {
      const status = component.status.toUpperCase().padEnd(10);
      const latency = component.latency ? `${component.latency}ms` : '';
      lines.push(`  ${component.name}: ${status} ${latency} ${component.message || ''}`);
    }

    return lines.join('\n');
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stopAutoCheck();
    this.customChecks.clear();
    this.componentHealth.clear();
    this.removeAllListeners();
  }
}

export default HealthChecker;
