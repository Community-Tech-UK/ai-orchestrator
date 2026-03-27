/**
 * Structured Logging - Per-subsystem logging with levels (13.1)
 *
 * Provides structured logging with configurable levels per subsystem.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

/**
 * Safely get the Electron app userData path.
 * Returns undefined if Electron is not available (e.g., in tests).
 */
function getElectronUserDataPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

/**
 * Log levels (in order of severity)
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Log level values for comparison
 */
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

/**
 * Log entry structure
 */
export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  subsystem: string;
  message: string;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  context?: {
    instanceId?: string;
    sessionId?: string;
    requestId?: string;
  };
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  globalLevel: LogLevel;
  subsystemLevels: Record<string, LogLevel>;
  enableConsole: boolean;
  enableFile: boolean;
  maxFileSize: number;        // Max log file size in bytes
  maxFiles: number;           // Max number of rotated files
  logDirectory?: string;
}

const DEFAULT_CONFIG: LoggerConfig = {
  globalLevel: 'info',
  subsystemLevels: {},
  enableConsole: true,
  enableFile: true,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
};

const MAX_LOG_MESSAGE_LENGTH = 2048;
const MAX_LOG_STRING_LENGTH = 4096;
const MAX_LOG_STACK_LENGTH = 8192;
const MAX_LOG_OBJECT_DEPTH = 4;
const MAX_LOG_OBJECT_KEYS = 40;
const MAX_LOG_ARRAY_ITEMS = 25;

function truncateLogString(value: string, maxLength = MAX_LOG_STRING_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

function summarizeObject(value: object): string {
  const constructorName = value.constructor?.name;
  return constructorName ? `[${constructorName}]` : '[Object]';
}

function sanitizeLogValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return truncateLogString(value);
  }

  if (typeof value === 'bigint') {
    return `${value}n`;
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateLogString(value.message),
      stack: value.stack ? truncateLogString(value.stack, MAX_LOG_STACK_LENGTH) : undefined,
    };
  }

  if (Buffer.isBuffer(value)) {
    return {
      type: 'Buffer',
      length: value.length,
    };
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_LOG_OBJECT_DEPTH) {
      return `[Array(${value.length})]`;
    }

    const items = value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((item) => sanitizeLogValue(item, depth + 1, seen));

    if (value.length > MAX_LOG_ARRAY_ITEMS) {
      items.push(`[+${value.length - MAX_LOG_ARRAY_ITEMS} more items]`);
    }

    return items;
  }

  if (value instanceof Map) {
    if (depth >= MAX_LOG_OBJECT_DEPTH) {
      return `[Map(${value.size})]`;
    }

    const entries = Array.from(value.entries()).slice(0, MAX_LOG_ARRAY_ITEMS).map(([key, entryValue]) => ({
      key: sanitizeLogValue(key, depth + 1, seen),
      value: sanitizeLogValue(entryValue, depth + 1, seen),
    }));

    if (value.size > MAX_LOG_ARRAY_ITEMS) {
      entries.push({ key: '__truncatedEntries', value: value.size - MAX_LOG_ARRAY_ITEMS });
    }

    return entries;
  }

  if (value instanceof Set) {
    if (depth >= MAX_LOG_OBJECT_DEPTH) {
      return `[Set(${value.size})]`;
    }

    const entries = Array.from(value.values())
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((entryValue) => sanitizeLogValue(entryValue, depth + 1, seen));

    if (value.size > MAX_LOG_ARRAY_ITEMS) {
      entries.push(`[+${value.size - MAX_LOG_ARRAY_ITEMS} more items]`);
    }

    return entries;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    if (depth >= MAX_LOG_OBJECT_DEPTH) {
      return summarizeObject(value);
    }

    seen.add(value);
    try {
      const keys = Object.keys(value);
      const sanitized: Record<string, unknown> = {};

      for (const key of keys.slice(0, MAX_LOG_OBJECT_KEYS)) {
        try {
          sanitized[key] = sanitizeLogValue(
            (value as Record<string, unknown>)[key],
            depth + 1,
            seen
          );
        } catch (error) {
          sanitized[key] = `[Thrown during logging: ${error instanceof Error ? error.message : String(error)}]`;
        }
      }

      if (keys.length > MAX_LOG_OBJECT_KEYS) {
        sanitized['__truncatedKeys'] = keys.length - MAX_LOG_OBJECT_KEYS;
      }

      return sanitized;
    } finally {
      seen.delete(value);
    }
  }

  return String(value);
}

function sanitizeLogData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }

  return sanitizeLogValue(data) as Record<string, unknown>;
}

/**
 * Subsystem logger - provides logging for a specific subsystem
 */
export class SubsystemLogger {
  constructor(
    protected manager: LogManager,
    protected subsystem: string
  ) {}

  debug(message: string, data?: Record<string, unknown>): void {
    this.manager.log('debug', this.subsystem, message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.manager.log('info', this.subsystem, message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.manager.log('warn', this.subsystem, message, data);
  }

  error(message: string, error?: Error, data?: Record<string, unknown>): void {
    this.manager.logError('error', this.subsystem, message, error, data);
  }

  fatal(message: string, error?: Error, data?: Record<string, unknown>): void {
    this.manager.logError('fatal', this.subsystem, message, error, data);
  }

  withContext(context: LogEntry['context']): ContextualLogger {
    return new ContextualLogger(this.manager, this.subsystem, context);
  }
}

/**
 * Contextual logger - includes context in all log entries
 */
export class ContextualLogger extends SubsystemLogger {
  constructor(
    manager: LogManager,
    subsystem: string,
    private context: LogEntry['context']
  ) {
    super(manager, subsystem);
  }

  override debug(message: string, data?: Record<string, unknown>): void {
    this.manager.log('debug', this.subsystem, message, data, this.context);
  }

  override info(message: string, data?: Record<string, unknown>): void {
    this.manager.log('info', this.subsystem, message, data, this.context);
  }

  override warn(message: string, data?: Record<string, unknown>): void {
    this.manager.log('warn', this.subsystem, message, data, this.context);
  }

  override error(message: string, error?: Error, data?: Record<string, unknown>): void {
    this.manager.logError('error', this.subsystem, message, error, data, this.context);
  }

  override fatal(message: string, error?: Error, data?: Record<string, unknown>): void {
    this.manager.logError('fatal', this.subsystem, message, error, data, this.context);
  }
}

/**
 * Log Manager - Central logging system
 */
export class LogManager extends EventEmitter {
  private config: LoggerConfig;
  private loggers = new Map<string, SubsystemLogger>();
  private logBuffer: LogEntry[] = [];
  private maxBufferSize = 10000;
  private logFile: string;
  private currentFileSize = 0;
  private writeQueue = Promise.resolve();

  constructor(config: Partial<LoggerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    const baseDir = this.config.logDirectory
      || getElectronUserDataPath()
      || path.join(os.tmpdir(), 'claude-orchestrator');

    // Disable file logging when running outside Electron (tests)
    if (!this.config.logDirectory && !getElectronUserDataPath()) {
      this.config.enableFile = false;
    }

    this.logFile = path.join(baseDir, 'logs', 'app.log');

    if (this.config.enableFile) {
      this.ensureLogDirectory();
    }
  }

  /**
   * Ensure log directory exists
   */
  private ensureLogDirectory(): void {
    const logDir = path.dirname(this.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  /**
   * Get or create a subsystem logger
   */
  getLogger(subsystem: string): SubsystemLogger {
    if (!this.loggers.has(subsystem)) {
      this.loggers.set(subsystem, new SubsystemLogger(this, subsystem));
    }
    return this.loggers.get(subsystem)!;
  }

  /**
   * Check if a log level should be logged for a subsystem
   */
  private shouldLog(level: LogLevel, subsystem: string): boolean {
    const subsystemLevel = this.config.subsystemLevels[subsystem] || this.config.globalLevel;
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[subsystemLevel];
  }

  /**
   * Log a message
   */
  log(
    level: LogLevel,
    subsystem: string,
    message: string,
    data?: Record<string, unknown>,
    context?: LogEntry['context']
  ): void {
    if (!this.shouldLog(level, subsystem)) return;

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      subsystem,
      message: truncateLogString(message, MAX_LOG_MESSAGE_LENGTH),
      data: sanitizeLogData(data),
      context,
    };

    this.processEntry(entry);
  }

  /**
   * Log an error
   */
  logError(
    level: LogLevel,
    subsystem: string,
    message: string,
    error?: Error,
    data?: Record<string, unknown>,
    context?: LogEntry['context']
  ): void {
    if (!this.shouldLog(level, subsystem)) return;

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      subsystem,
      message: truncateLogString(message, MAX_LOG_MESSAGE_LENGTH),
      data: sanitizeLogData(data),
      context,
      error: error ? {
        name: error.name,
        message: truncateLogString(error.message, MAX_LOG_MESSAGE_LENGTH),
        stack: error.stack ? truncateLogString(error.stack, MAX_LOG_STACK_LENGTH) : undefined,
      } : undefined,
    };

    this.processEntry(entry);
  }

  /**
   * Process a log entry
   */
  private processEntry(entry: LogEntry): void {
    // Add to buffer
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer = this.logBuffer.slice(-this.maxBufferSize);
    }

    // Console output
    if (this.config.enableConsole) {
      this.writeToConsole(entry);
    }

    // File output
    if (this.config.enableFile) {
      this.writeToFile(entry);
    }

    // Emit event
    this.emit('log', entry);
  }

  /**
   * Write log entry to console
   */
  private writeToConsole(entry: LogEntry): void {
    const timestamp = new Date(entry.timestamp).toISOString();
    const prefix = `[${timestamp}] [${entry.level.toUpperCase()}] [${entry.subsystem}]`;
    const message = `${prefix} ${entry.message}`;

    switch (entry.level) {
      case 'debug':
        console.debug(message, entry.data || '');
        break;
      case 'info':
        console.info(message, entry.data || '');
        break;
      case 'warn':
        console.warn(message, entry.data || '');
        break;
      case 'error':
      case 'fatal':
        console.error(message, entry.data || '', entry.error || '');
        break;
    }
  }

  /**
   * Write log entry to file (async via write queue to prevent interleaving)
   */
  private writeToFile(entry: LogEntry): void {
    const line = JSON.stringify(entry) + '\n';
    const lineSize = Buffer.byteLength(line);

    this.writeQueue = this.writeQueue.then(async () => {
      try {
        // Check if rotation is needed
        if (this.currentFileSize + lineSize > this.config.maxFileSize) {
          this.rotateLogFile();
        }

        await fs.promises.appendFile(this.logFile, line);
        this.currentFileSize += lineSize;
      } catch (err) {
        console.error('Failed to write log:', err);
      }
    });
  }

  /**
   * Rotate log files
   */
  private rotateLogFile(): void {
    try {
      // Rename existing rotated files
      for (let i = this.config.maxFiles - 1; i >= 1; i--) {
        const oldPath = `${this.logFile}.${i}`;
        const newPath = `${this.logFile}.${i + 1}`;
        if (fs.existsSync(oldPath)) {
          if (i === this.config.maxFiles - 1) {
            fs.unlinkSync(oldPath);
          } else {
            fs.renameSync(oldPath, newPath);
          }
        }
      }

      // Rename current log file
      if (fs.existsSync(this.logFile)) {
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      }

      this.currentFileSize = 0;
    } catch (error) {
      console.error('Failed to rotate log file:', error);
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): LoggerConfig {
    return { ...this.config };
  }

  /**
   * Set log level for a subsystem
   */
  setSubsystemLevel(subsystem: string, level: LogLevel): void {
    this.config.subsystemLevels[subsystem] = level;
  }

  /**
   * Set global log level
   */
  setGlobalLevel(level: LogLevel): void {
    this.config.globalLevel = level;
  }

  /**
   * Get recent log entries
   */
  getRecentLogs(options: {
    limit?: number;
    level?: LogLevel;
    subsystem?: string;
    startTime?: number;
    endTime?: number;
  } = {}): LogEntry[] {
    let entries = [...this.logBuffer];

    if (options.level) {
      const minLevel = LOG_LEVEL_VALUES[options.level];
      entries = entries.filter((e) => LOG_LEVEL_VALUES[e.level] >= minLevel);
    }

    if (options.subsystem) {
      entries = entries.filter((e) => e.subsystem === options.subsystem);
    }

    if (options.startTime) {
      entries = entries.filter((e) => e.timestamp >= options.startTime!);
    }

    if (options.endTime) {
      entries = entries.filter((e) => e.timestamp <= options.endTime!);
    }

    if (options.limit) {
      entries = entries.slice(-options.limit);
    }

    return entries;
  }

  /**
   * Clear log buffer
   */
  clearBuffer(): void {
    this.logBuffer = [];
  }

  /**
   * Get all registered subsystems
   */
  getSubsystems(): string[] {
    return Array.from(this.loggers.keys());
  }

  /**
   * Export logs to file
   */
  exportLogs(filePath: string, options: { startTime?: number; endTime?: number } = {}): void {
    const entries = this.getRecentLogs(options);
    const content = entries.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(filePath, content);
  }

  /**
   * Get log file paths
   */
  getLogFilePaths(): string[] {
    const paths: string[] = [this.logFile];
    for (let i = 1; i <= this.config.maxFiles; i++) {
      const rotatedPath = `${this.logFile}.${i}`;
      if (fs.existsSync(rotatedPath)) {
        paths.push(rotatedPath);
      }
    }
    return paths;
  }
}

// Singleton instance
let logManagerInstance: LogManager | null = null;

export function getLogManager(): LogManager {
  if (!logManagerInstance) {
    logManagerInstance = new LogManager();
  }
  return logManagerInstance;
}

// Convenience function for quick logging
export function getLogger(subsystem: string): SubsystemLogger {
  return getLogManager().getLogger(subsystem);
}

/**
 * Generate a unique request/correlation ID for tracing requests through the system.
 * Format: `req-{timestamp}-{random}` — suitable for log correlation, API headers,
 * and debugging multi-instance orchestration flows.
 * Inspired by Claude Code 2.1.84 x-client-request-id header pattern.
 */
export function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a contextual logger pre-bound with instance/session/request IDs.
 * Usage: `const log = createContextualLogger('MyService', { instanceId, requestId })`
 */
export function createContextualLogger(
  subsystem: string,
  context: LogEntry['context']
): ContextualLogger {
  return getLogManager().getLogger(subsystem).withContext(context);
}

/**
 * Reset the LogManager singleton for testing.
 * Clears all loggers, buffers, and resets to default config.
 */
export function _resetLogManagerForTesting(): void {
  if (logManagerInstance) {
    logManagerInstance.clearBuffer();
    logManagerInstance.removeAllListeners();
    logManagerInstance = null;
  }
}
