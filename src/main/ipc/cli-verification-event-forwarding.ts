import { getLogger } from '../logging/logger';
import type { getCliVerificationCoordinator } from '../orchestration/cli-verification-extension';

const logger = getLogger('CliVerification');

type SendToRenderer = (channel: string, data: unknown) => void;

export function setupCoordinatorEvents(
  coordinator: ReturnType<typeof getCliVerificationCoordinator>,
  sendToRenderer: SendToRenderer,
): void {
  logger.info('Setting up coordinator event forwarding');

  coordinator.on('verification:started', (data) => {
    logger.info('Forwarding verification:started', { data });
    sendToRenderer('verification:started', data);
  });

  coordinator.on('verification:agents-launching', (data) => {
    logger.info('Forwarding verification:agents-launching', {
      requestId: data.requestId,
      agentCount: data.agents?.length,
    });
    for (let index = 0; index < data.agents.length; index++) {
      const agent = data.agents[index];
      const agentId = `${data.requestId}-${agent.name.toLowerCase().replace(/\s+/g, '-')}-${index}`;
      const payload = {
        sessionId: data.requestId,
        agentId,
        name: agent.name,
        type: agent.type,
        personality: agent.personality,
      };
      logger.info('Sending verification:agent-start', payload);
      sendToRenderer('verification:agent-start', payload);
    }
  });

  const agentContent = new Map<string, string>();

  coordinator.on('verification:agent-stream', (data) => {
    const currentContent = agentContent.get(data.agentId) || '';
    agentContent.set(data.agentId, currentContent + (data.content || ''));

    const payload = {
      sessionId: data.requestId,
      agentId: data.agentId,
      chunk: data.content,
    };
    logger.info('Sending verification:agent-stream', {
      agentId: data.agentId,
      chunkLength: (data.content || '').length,
    });
    sendToRenderer('verification:agent-stream', payload);
  });

  coordinator.on('verification:agent-complete', (data) => {
    const finalContent = data.totalContent || agentContent.get(data.agentId) || '';
    const payload = {
      sessionId: data.requestId,
      response: {
        agentId: data.agentId,
        agentIndex: 0,
        model: data.agentName || 'unknown',
        response: finalContent,
        keyPoints: [],
        confidence: data.success ? 1 : 0,
        duration: 0,
        tokens: data.tokens || 0,
        cost: 0,
        error: data.error,
      },
    };
    logger.info('Sending verification:agent-complete', {
      agentId: data.agentId,
      success: data.success,
      responseLength: finalContent.length,
    });
    sendToRenderer('verification:agent-complete', payload);
    agentContent.delete(data.agentId);
  });

  coordinator.on('verification:agent-error', (data) => {
    const payload = {
      sessionId: data.requestId,
      agentId: data.agentId,
      error: data.error || 'Unknown agent error',
    };
    logger.info('Sending verification:agent-error', {
      agentId: data.agentId,
      error: payload.error,
    });
    sendToRenderer('verification:agent-error', payload);
  });

  coordinator.on('verification:round-progress', (data) => {
    const payload = {
      sessionId: data.requestId,
      round: data.round,
      total: data.total,
    };
    logger.info('Sending verification:round-progress', payload);
    sendToRenderer('verification:round-progress', payload);
  });

  coordinator.on('verification:consensus-update', (data) => {
    const payload = {
      sessionId: data.requestId,
      score: data.score,
    };
    logger.info('Sending verification:consensus-update', payload);
    sendToRenderer('verification:consensus-update', payload);
  });

  coordinator.on('verification:completed', (result) => {
    logger.info('Sending verification:complete', {
      sessionId: result.id,
      hasResult: !!result,
    });
    sendToRenderer('verification:complete', {
      sessionId: result.id,
      result,
    });
  });

  coordinator.on('verification:error', (data) => {
    logger.info('Sending verification:error', {
      sessionId: data.requestId,
      error: data.error?.message,
    });
    sendToRenderer('verification:error', {
      sessionId: data.requestId,
      error: data.error?.message || 'Unknown error',
    });
  });

  coordinator.on('verification:cancelled', (data) => {
    sendToRenderer('verification:cancelled', {
      sessionId: data.verificationId,
      reason: data.reason,
      agentsCancelled: data.agentsCancelled,
    });
  });

  coordinator.on('verification:agent-cancelled', (data) => {
    sendToRenderer('verification:agent-cancelled', {
      sessionId: data.verificationId,
      agentId: data.agentId,
    });
  });

  coordinator.on('warning', (data) => {
    sendToRenderer('verification:warning', data);
  });
}
