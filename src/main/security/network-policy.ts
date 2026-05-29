/**
 * Network Policy - Network isolation and access control for sandboxing
 *
 * Features:
 * - Domain allowlist and blocklist management
 * - URL validation and filtering
 * - Rate limiting for network requests
 * - Proxy configuration support
 * - Request logging and auditing
 * - Real-time statistics and monitoring
 *
 * Implements singleton pattern with event emission for monitoring.
 */

import { EventEmitter } from 'events';

/**
 * Network policy configuration
 */
export interface NetworkPolicyConfig {
  /** Domains allowed to access (empty = block all unless allowAllTraffic is true) */
  allowedDomains: string[];
  /** Explicitly blocked domains (takes precedence over allowed) */
  blockedDomains: string[];
  /** Disable network filtering entirely */
  allowAllTraffic: boolean;
  /** Enable proxy for network requests */
  proxyEnabled: boolean;
  /** Proxy host address */
  proxyHost?: string;
  /** Proxy port number */
  proxyPort?: number;
  /** Log all network requests */
  logRequests: boolean;
  /** Maximum requests per minute (0 = unlimited) */
  maxRequestsPerMinute: number;
}

/**
 * Network request record
 */
export interface NetworkRequest {
  /** Full URL of the request */
  url: string;
  /** Extracted domain from URL */
  domain: string;
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Request timestamp */
  timestamp: number;
  /** Whether request was allowed */
  allowed: boolean;
  /** Reason for allow/deny decision */
  reason: string;
}

/**
 * Network policy statistics
 */
export interface NetworkPolicyStats {
  /** Total requests processed */
  totalRequests: number;
  /** Requests allowed */
  allowedRequests: number;
  /** Requests denied */
  deniedRequests: number;
  /** Requests blocked by domain */
  blockedRequests: number;
  /** Rate limit violations */
  rateLimitViolations: number;
  /** Number of allowed domains */
  allowedDomainsCount: number;
  /** Number of blocked domains */
  blockedDomainsCount: number;
  /** Current requests per minute */
  currentRequestsPerMinute: number;
  /** Uptime in milliseconds */
  uptime: number;
}

/**
 * Default configuration with common safe domains
 */
export const DEFAULT_NETWORK_CONFIG: NetworkPolicyConfig = {
  allowedDomains: [
    // AI API providers
    'api.anthropic.com',
    'api.openai.com',
    'api.cohere.ai',
    'api.replicate.com',

    // Code hosting and package registries
    'github.com',
    'api.github.com',
    'raw.githubusercontent.com',
    'gitlab.com',
    'bitbucket.org',

    // Package managers
    'npmjs.org',
    'registry.npmjs.org',
    'pypi.org',
    'files.pythonhosted.org',
    'crates.io',
    'rubygems.org',
    'packagist.org',

    // CDNs and documentation
    'cdn.jsdelivr.net',
    'unpkg.com',
    'cdnjs.cloudflare.com',
    'docs.rs',
    'devdocs.io',

    // Model metadata registry (context windows + pricing)
    'models.dev',

    // Cloud providers (for API access)
    'amazonaws.com',
    'cloudflare.com',
    'googleusercontent.com',
  ],
  blockedDomains: [
    // Malware and phishing (placeholder examples)
    'malware-domain.com',
    'phishing-site.net',
    'suspicious-domain.xyz',

    // Local network (can be configured)
    // 'localhost' - configurable based on security needs
  ],
  allowAllTraffic: false,
  proxyEnabled: false,
  proxyHost: undefined,
  proxyPort: undefined,
  logRequests: true,
  maxRequestsPerMinute: 60, // Default: 1 request per second average
};

/**
 * Network Policy Manager
 */
export class NetworkPolicy extends EventEmitter {
  private static instance: NetworkPolicy | null = null;

  private config: NetworkPolicyConfig;
  private requestHistory: NetworkRequest[] = [];
  private stats: NetworkPolicyStats;
  private startTime: number;
  private requestTimestamps: number[] = [];

  private constructor() {
    super();
    this.config = { ...DEFAULT_NETWORK_CONFIG };
    this.startTime = Date.now();
    this.stats = this.initializeStats();
    this.startCleanup();
  }

  static getInstance(): NetworkPolicy {
    if (!NetworkPolicy.instance) {
      NetworkPolicy.instance = new NetworkPolicy();
    }
    return NetworkPolicy.instance;
  }

  static _resetForTesting(): void {
    NetworkPolicy.instance = null;
  }

  /**
   * Configure the network policy
   */
  configure(config: Partial<NetworkPolicyConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configured', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): NetworkPolicyConfig {
    return { ...this.config };
  }

  /**
   * Check if a URL can be accessed
   */
  canAccessUrl(url: string): { allowed: boolean; reason: string } {
    try {
      const domain = this.extractDomain(url);
      return this.canAccessDomain(domain);
    } catch (error) {
      return {
        allowed: false,
        reason: `Invalid URL format: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Check if a domain can be accessed
   */
  canAccessDomain(domain: string): { allowed: boolean; reason: string } {
    const normalizedDomain = this.normalizeDomain(domain);

    // Check rate limiting first
    if (!this.checkRateLimit()) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${this.config.maxRequestsPerMinute} requests/minute`,
      };
    }

    // If allowAllTraffic is enabled, allow everything unless explicitly blocked
    if (this.config.allowAllTraffic) {
      // Still check blocklist
      if (this.isBlocked(normalizedDomain)) {
        return {
          allowed: false,
          reason: `Domain is explicitly blocked: ${normalizedDomain}`,
        };
      }
      return {
        allowed: true,
        reason: 'All traffic allowed by policy',
      };
    }

    // Check blocklist first (takes precedence)
    if (this.isBlocked(normalizedDomain)) {
      return {
        allowed: false,
        reason: `Domain is blocked: ${normalizedDomain}`,
      };
    }

    // Check allowlist
    if (this.isAllowed(normalizedDomain)) {
      return {
        allowed: true,
        reason: `Domain is in allowlist: ${normalizedDomain}`,
      };
    }

    // Default deny if not in allowlist and not allowing all traffic
    return {
      allowed: false,
      reason: `Domain not in allowlist: ${normalizedDomain}`,
    };
  }

  /**
   * Add a domain to the allowlist
   */
  addAllowedDomain(domain: string): void {
    const normalizedDomain = this.normalizeDomain(domain);
    if (!this.config.allowedDomains.includes(normalizedDomain)) {
      this.config.allowedDomains.push(normalizedDomain);
      this.emit('domain:allowed', { domain: normalizedDomain });
    }
  }

  /**
   * Remove a domain from both allowlist and blocklist
   */
  removeDomain(domain: string): void {
    const normalizedDomain = this.normalizeDomain(domain);

    const allowedIndex = this.config.allowedDomains.indexOf(normalizedDomain);
    if (allowedIndex !== -1) {
      this.config.allowedDomains.splice(allowedIndex, 1);
      this.emit('domain:removed', { domain: normalizedDomain, list: 'allowed' });
    }

    const blockedIndex = this.config.blockedDomains.indexOf(normalizedDomain);
    if (blockedIndex !== -1) {
      this.config.blockedDomains.splice(blockedIndex, 1);
      this.emit('domain:removed', { domain: normalizedDomain, list: 'blocked' });
    }
  }

  /**
   * Add a domain to the blocklist
   */
  blockDomain(domain: string): void {
    const normalizedDomain = this.normalizeDomain(domain);
    if (!this.config.blockedDomains.includes(normalizedDomain)) {
      this.config.blockedDomains.push(normalizedDomain);
      this.emit('domain:blocked', { domain: normalizedDomain });
    }
  }

  /**
   * Record a network request
   */
  recordRequest(url: string, method: string = 'GET'): NetworkRequest {
    const domain = this.extractDomain(url);
    const check = this.canAccessDomain(domain);

    const request: NetworkRequest = {
      url,
      domain,
      method,
      timestamp: Date.now(),
      allowed: check.allowed,
      reason: check.reason,
    };

    // Update statistics
    this.stats.totalRequests++;
    if (check.allowed) {
      this.stats.allowedRequests++;
    } else {
      this.stats.deniedRequests++;
      if (this.isBlocked(domain)) {
        this.stats.blockedRequests++;
      }
    }

    // Add to history if logging is enabled
    if (this.config.logRequests) {
      this.requestHistory.push(request);
      // Keep only last 1000 requests
      if (this.requestHistory.length > 1000) {
        this.requestHistory.shift();
      }
    }

    // Track for rate limiting
    this.requestTimestamps.push(Date.now());

    // Emit appropriate event
    if (check.allowed) {
      this.emit('request:allowed', request);
    } else if (this.isBlocked(domain)) {
      this.emit('request:blocked', request);
    } else {
      this.emit('request:denied', request);
    }

    return request;
  }

  /**
   * Get recent requests
   */
  getRecentRequests(limit: number = 100): NetworkRequest[] {
    return this.requestHistory.slice(-limit);
  }

  /**
   * Check rate limit
   */
  checkRateLimit(): boolean {
    if (this.config.maxRequestsPerMinute === 0) {
      return true; // No rate limiting
    }

    // Clean old timestamps (older than 1 minute)
    const oneMinuteAgo = Date.now() - 60000;
    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > oneMinuteAgo);

    // Check if we're over the limit
    if (this.requestTimestamps.length >= this.config.maxRequestsPerMinute) {
      this.stats.rateLimitViolations++;
      this.emit('rate-limit:exceeded', {
        limit: this.config.maxRequestsPerMinute,
        current: this.requestTimestamps.length,
      });
      return false;
    }

    return true;
  }

  /**
   * Get current statistics
   */
  getStats(): NetworkPolicyStats {
    // Update dynamic stats
    const oneMinuteAgo = Date.now() - 60000;
    const recentRequests = this.requestTimestamps.filter((ts) => ts > oneMinuteAgo);

    return {
      ...this.stats,
      allowedDomainsCount: this.config.allowedDomains.length,
      blockedDomainsCount: this.config.blockedDomains.length,
      currentRequestsPerMinute: recentRequests.length,
      uptime: Date.now() - this.startTime,
    };
  }

  /**
   * Extract domain from URL
   */
  extractDomain(url: string): string {
    try {
      // Handle URLs without protocol
      let processedUrl = url;
      if (!url.match(/^https?:\/\//i)) {
        processedUrl = `https://${url}`;
      }

      const urlObj = new URL(processedUrl);
      return urlObj.hostname;
    } catch (error) {
      // If URL parsing fails, try to extract domain manually
      const match = url.match(/(?:https?:\/\/)?(?:www\.)?([^/:?#]+)/i);
      if (match && match[1]) {
        return match[1];
      }
      throw new Error(`Invalid URL: ${url}`);
    }
  }

  /**
   * Get proxy configuration if enabled
   */
  getProxyConfig(): { host: string; port: number } | null {
    if (!this.config.proxyEnabled || !this.config.proxyHost || !this.config.proxyPort) {
      return null;
    }
    return {
      host: this.config.proxyHost,
      port: this.config.proxyPort,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = this.initializeStats();
    this.requestHistory = [];
    this.requestTimestamps = [];
    this.startTime = Date.now();
    this.emit('stats:reset');
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.requestHistory = [];
    this.requestTimestamps = [];
    this.removeAllListeners();
    NetworkPolicy.instance = null;
  }

  // ============================================
  // Private Methods
  // ============================================

  private initializeStats(): NetworkPolicyStats {
    return {
      totalRequests: 0,
      allowedRequests: 0,
      deniedRequests: 0,
      blockedRequests: 0,
      rateLimitViolations: 0,
      allowedDomainsCount: this.config.allowedDomains.length,
      blockedDomainsCount: this.config.blockedDomains.length,
      currentRequestsPerMinute: 0,
      uptime: 0,
    };
  }

  private normalizeDomain(domain: string): string {
    // Remove protocol if present
    let normalized = domain.replace(/^https?:\/\//i, '');
    // Remove www. prefix
    normalized = normalized.replace(/^www\./i, '');
    // Remove trailing slash and path
    normalized = normalized.split('/')[0];
    // Remove port
    normalized = normalized.split(':')[0];
    // Convert to lowercase
    return normalized.toLowerCase();
  }

  private isAllowed(domain: string): boolean {
    const normalizedDomain = this.normalizeDomain(domain);

    for (const allowedDomain of this.config.allowedDomains) {
      const normalizedAllowed = this.normalizeDomain(allowedDomain);

      // Exact match
      if (normalizedDomain === normalizedAllowed) {
        return true;
      }

      // Wildcard subdomain match (*.example.com)
      if (normalizedAllowed.startsWith('*.')) {
        const baseDomain = normalizedAllowed.slice(2);
        if (normalizedDomain === baseDomain || normalizedDomain.endsWith(`.${baseDomain}`)) {
          return true;
        }
      }

      // Subdomain match (allow subdomains of allowed domains)
      if (normalizedDomain.endsWith(`.${normalizedAllowed}`)) {
        return true;
      }
    }

    return false;
  }

  private isBlocked(domain: string): boolean {
    const normalizedDomain = this.normalizeDomain(domain);

    for (const blockedDomain of this.config.blockedDomains) {
      const normalizedBlocked = this.normalizeDomain(blockedDomain);

      // Exact match
      if (normalizedDomain === normalizedBlocked) {
        return true;
      }

      // Wildcard subdomain match (*.example.com)
      if (normalizedBlocked.startsWith('*.')) {
        const baseDomain = normalizedBlocked.slice(2);
        if (normalizedDomain === baseDomain || normalizedDomain.endsWith(`.${baseDomain}`)) {
          return true;
        }
      }

      // Subdomain match (block subdomains of blocked domains)
      if (normalizedDomain.endsWith(`.${normalizedBlocked}`)) {
        return true;
      }
    }

    return false;
  }

  private startCleanup(): void {
    // Cleanup old request timestamps every minute
    const cleanupInterval = setInterval(() => {
      const oneMinuteAgo = Date.now() - 60000;
      this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > oneMinuteAgo);

      // Keep only last 1000 requests in history
      if (this.requestHistory.length > 1000) {
        this.requestHistory = this.requestHistory.slice(-1000);
      }
    }, 60000);

    if (cleanupInterval.unref) {
      cleanupInterval.unref();
    }
  }
}

/**
 * Get the network policy singleton
 */
export function getNetworkPolicy(): NetworkPolicy {
  return NetworkPolicy.getInstance();
}

export default NetworkPolicy;
