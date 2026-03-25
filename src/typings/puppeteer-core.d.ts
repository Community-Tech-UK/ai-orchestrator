/**
 * Ambient module declaration for puppeteer-core
 * The actual package is loaded lazily at runtime only when a WhatsApp connection is initiated.
 */
declare module 'puppeteer-core' {
  const puppeteer: Record<string, unknown>;
  export default puppeteer;
}
