/**
 * Must load before zone.js, which reads these flags as it starts.
 *
 * zone.js is the browser build, so it patches the global `EventTarget`. Under jsdom that
 * is jsdom's own class. Under the `node` environment it is Node's real one, which
 * `MessagePort` and so `worker_threads` are built on, and the patch stops messages
 * reaching a Worker's listeners: any spec starting a real worker times out waiting.
 */
(globalThis as Record<string, unknown>)['__Zone_disable_EventTarget'] = true;
