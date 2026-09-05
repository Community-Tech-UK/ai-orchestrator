"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstanceAsyncWorkContinuation = exports.ASYNC_WORK_CONTINUATION_PROMPT = void 0;
exports.initializeInstanceAsyncWorkContinuation = initializeInstanceAsyncWorkContinuation;
exports._disposeInstanceAsyncWorkContinuationForTesting = _disposeInstanceAsyncWorkContinuationForTesting;
const logger_1 = require("../logging/logger");
const cleanup_registry_1 = require("../util/cleanup-registry");
const instance_async_work_registry_1 = require("./instance-async-work-registry");
const logger = (0, logger_1.getLogger)('InstanceAsyncWorkContinuation');
const SETTLEMENT_TIMEOUT_MS = 60_000;
exports.ASYNC_WORK_CONTINUATION_PROMPT = 'A background task has finished. Review its task notification and result, then continue the work you were waiting to complete.';
class InstanceAsyncWorkContinuation {
    registry;
    host;
    pendingRequestCounts = new Map();
    started = false;
    onTerminal = (notification) => {
        const { instanceId } = notification;
        if (this.pendingRequestCounts.has(instanceId)) {
            return;
        }
        const instance = this.host.getInstance(instanceId);
        if (!instance) {
            this.registry.finishCompletionDelivery(instanceId);
            return;
        }
        this.pendingRequestCounts.set(instanceId, instance.requestCount);
        queueMicrotask(() => {
            void this.deliver(notification).catch((error) => {
                logger.warn('Background-result continuation failed', {
                    instanceId,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        });
    };
    constructor(registry, host) {
        this.registry = registry;
        this.host = host;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        this.registry.on('work:terminal', this.onTerminal);
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        this.registry.off('work:terminal', this.onTerminal);
        for (const instanceId of this.pendingRequestCounts.keys()) {
            this.registry.finishCompletionDelivery(instanceId);
        }
        this.pendingRequestCounts.clear();
    }
    async deliver(notification) {
        const { instanceId } = notification;
        const requestCountAtCompletion = this.pendingRequestCounts.get(instanceId);
        if (requestCountAtCompletion === undefined)
            return;
        try {
            const instanceAtCompletion = this.host.getInstance(instanceId);
            const alreadyReady = instanceAtCompletion?.status === 'idle'
                || instanceAtCompletion?.status === 'ready'
                || instanceAtCompletion?.status === 'hibernated';
            if (!alreadyReady) {
                try {
                    await this.host.waitForInstanceSettled(instanceId, { timeoutMs: SETTLEMENT_TIMEOUT_MS });
                }
                catch (error) {
                    logger.warn('Background-result continuation timed out waiting for settlement', {
                        instanceId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return;
                }
            }
            const instance = this.host.getInstance(instanceId);
            if (!instance || instance.requestCount !== requestCountAtCompletion) {
                logger.info('Background-result continuation suppressed by a newer turn', {
                    instanceId,
                    requestCountAtCompletion,
                    currentRequestCount: instance?.requestCount,
                });
                return;
            }
            if (instance.status !== 'idle'
                && instance.status !== 'ready'
                && instance.status !== 'hibernated') {
                logger.info('Background-result continuation suppressed because the instance is unavailable', {
                    instanceId,
                    status: instance.status,
                });
                return;
            }
            await this.host.sendInput(instanceId, exports.ASYNC_WORK_CONTINUATION_PROMPT, undefined, { autoContinuation: true });
        }
        finally {
            this.pendingRequestCounts.delete(instanceId);
            this.registry.finishCompletionDelivery(instanceId);
        }
    }
}
exports.InstanceAsyncWorkContinuation = InstanceAsyncWorkContinuation;
let activeContinuation = null;
function initializeInstanceAsyncWorkContinuation(host) {
    activeContinuation?.stop();
    activeContinuation = new InstanceAsyncWorkContinuation((0, instance_async_work_registry_1.getInstanceAsyncWorkRegistry)(), host);
    activeContinuation.start();
    (0, cleanup_registry_1.registerCleanup)(() => {
        activeContinuation?.stop();
        activeContinuation = null;
    });
    return activeContinuation;
}
function _disposeInstanceAsyncWorkContinuationForTesting() {
    activeContinuation?.stop();
    activeContinuation = null;
}
//# sourceMappingURL=instance-async-work-continuation.js.map