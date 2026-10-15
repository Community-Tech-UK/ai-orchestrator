/**
 * Ambient module declaration for puppeteer-core
 * The actual package is loaded lazily at runtime only when a WhatsApp connection is initiated.
 */
declare module 'puppeteer-core' {
  export interface LaunchOptions {
    executablePath?: string;
    headless?: boolean | 'new';
    userDataDir?: string;
    args?: string[];
    defaultViewport?: { width: number; height: number } | null;
  }

  export interface Browser {
    pages(): Promise<Page[]>;
    newPage(): Promise<Page>;
    close(): Promise<void>;
    disconnect(): void;
    wsEndpoint(): string;
    process(): { pid?: number } | null;
  }

  export interface ConsoleMessage {
    type(): string;
    text(): string;
    location(): {
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
    };
  }

  export interface HTTPRequest {
    url(): string;
    method(): string;
    resourceType(): string;
    headers(): Record<string, string>;
  }

  export interface ElementHandle {
    uploadFile(...filePaths: string[]): Promise<void>;
  }

  export interface Keyboard {
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
    press(key: string): Promise<void>;
    type(text: string, options?: { delay?: number }): Promise<void>;
  }

  export interface Viewport {
    width: number;
    height: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
    isLandscape?: boolean;
  }

  export interface Page {
    url(): string;
    title(): Promise<string>;
    keyboard: Keyboard;
    setViewport(viewport: Viewport | null): Promise<void>;
    viewport(): Viewport | null;
    goto(
      url: string,
      options?: {
        waitUntil?: 'domcontentloaded' | 'networkidle0';
        timeout?: number;
      },
    ): Promise<unknown>;
    screenshot(options?: {
      type?: 'png' | 'jpeg';
      encoding?: 'base64';
      fullPage?: boolean;
    }): Promise<string | Uint8Array>;
    evaluate<T>(fn: () => T): Promise<T>;
    $eval<T>(
      selector: string,
      fn: (element: unknown) => T | Promise<T>,
    ): Promise<T>;
    $(selector: string): Promise<ElementHandle | null>;
    click(selector: string): Promise<void>;
    type(selector: string, text: string): Promise<void>;
    select(selector: string, value: string): Promise<string[]>;
    waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
    on?(
      event: 'console',
      handler: (message: ConsoleMessage) => void,
    ): Page;
    on?(
      event: 'request',
      handler: (request: HTTPRequest) => void,
    ): Page;
  }

  const puppeteer: {
    launch(options: LaunchOptions): Promise<Browser>;
    connect(options: { browserWSEndpoint: string }): Promise<Browser>;
  };
  export default puppeteer;
}
