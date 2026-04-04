import { Bonjour, type Browser, type Service } from 'bonjour-service';

export interface DiscoveredCoordinator {
  host: string;
  port: number;
  namespace: string;
  version: string;
}

export class DiscoveryClient {
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;

  async discover(namespace: string, timeoutMs = 10_000): Promise<DiscoveredCoordinator | null> {
    return new Promise((resolve) => {
      const bonjour = new Bonjour();
      const timer = setTimeout(() => {
        browser.stop();
        bonjour.destroy();
        resolve(null);
      }, timeoutMs);

      const browser = bonjour.find({ type: 'ai-orchestrator' }, (service: Service) => {
        if (service.txt?.namespace === namespace) {
          clearTimeout(timer);
          browser.stop();
          bonjour.destroy();
          resolve({
            host: service.host,
            port: service.port,
            namespace: service.txt.namespace as string,
            version: (service.txt.version as string | undefined) ?? 'unknown',
          });
        }
      });
    });
  }

  startContinuous(
    namespace: string,
    onUp: (coordinator: DiscoveredCoordinator) => void,
    onDown?: (name: string) => void,
  ): void {
    this.stopContinuous();
    this.bonjour = new Bonjour();
    this.browser = this.bonjour.find({ type: 'ai-orchestrator' });

    this.browser.on('up', (service: Service) => {
      if (service.txt?.namespace === namespace) {
        onUp({
          host: service.host,
          port: service.port,
          namespace: service.txt.namespace as string,
          version: (service.txt.version as string | undefined) ?? 'unknown',
        });
      }
    });

    if (onDown) {
      this.browser.on('down', (service: Service) => {
        onDown(service.name);
      });
    }
  }

  stopContinuous(): void {
    this.browser?.stop();
    this.bonjour?.destroy();
    this.bonjour = null;
    this.browser = null;
  }
}
