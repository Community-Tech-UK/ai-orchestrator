/**
 * Structured Logging - Per-subsystem logging with levels (13.1)
 *
 * Provides structured logging with configurable levels per subsystem.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { EventEmitter } from 'events';

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

/**
 * Subsystem logger - provides logging for a specific subsystem
 */
export class SubsystemLogger {
  constructor(
    private manager: LogManager,
    private subsystem: string
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
    (this as any).manager.log('debug', (this as any).subsystem, message, data, this.context);
  }

  override info(message: string, data?: Record<string, unknown>): void {
    (this as any).manager.log('info', (this as any).subsystem, message, data, this.context);
  }

  override warn(message: string, data?: Record<string, unknown>): void {
    (this as any).manager.log('warn', (this as any).subsystem, message, data, this.context);
  }

  override error(message: string, error?: Error, data?: Record<string, unknown>): void {
    (this as any).manager.logError('error', (this as any).subsystem, message, error, data, this.context);
  }

  override fatal(message: string, error?: Error, data?: Record<string, unknown>): void {
    (this as any).manager.logError('fatal', (this as any).subsystem, message, error, data, this.context);
  }
}

/**
 * Log Manager - Central logging system
 */
export class LogManager extends EventEmitter {
  private config: LoggerConfig;
  private loggers: Map<string, SubsystemLogger> = new Map();
  private logBuffer: LogEntry[] = [];
  private maxBufferSize: number = 10000;
  private logFile: string;
  private currentFileSize: number = 0;

  constructor(config: Partial<LoggerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logFile = path.join(
      this.config.logDirectory || app.getPath('userData'),
      'logs',
      'app.log'
    );
    this.ensureLogDirectory();
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
      message,
      data,
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
      message,
      data,
      context,
      error: error ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
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
   * Write log entry to file
   */
  private writeToFile(entry: LogEntry): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      const lineSize = Buffer.byteLength(line);

      // Check if rotation is needed
      if (this.currentFileSize + lineSize > this.config.maxFileSize) {
        this.rotateLogFile();
      }

      fs.appendFileSync(this.logFile, line);
      this.currentFileSize += lineSize;
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
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
