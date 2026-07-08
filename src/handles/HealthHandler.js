import sessionManager from '../services/sessionManager.js';
import rabbitmq from '../services/rabbitMQService.js';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';

class HealthHandler {
  constructor() {
    this.healthCheckInterval = null;
  }

  startHealthChecks() {
    logger.info('Starting periodic health checks...');

    this.healthCheckInterval = setInterval(async () => {
      await this.checkAllSessions();
    }, config.whatsapp.healthCheckInterval);
  }

  stopHealthChecks() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      logger.info('Health checks stopped');
    }
  }

  async checkAllSessions() {
    // 1. Run inactivity cleanup first
    try {
      await sessionManager.cleanInactiveSessions();
    } catch (cleanupError) {
      logger.error('Error during inactive sessions cleanup:', cleanupError);
    }

    // 2. Perform health check on remaining active sessions
    const sessions = sessionManager.getActiveSessions();

    logger.debug(`Performing health check on ${sessions.length} sessions`);

    for (const session of sessions) {
      await this.checkSession(session);
    }
  }

  async checkSession(session) {
    try {
      const { numberId, connected, sessionId } = session;

      if (!connected) {
        logger.warn(`Session ${sessionId} is not connected`);

        await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
          numberId,
          status: 'DISCONNECTED',
          reason: 'Session not connected',
        });

        // Try to automatically reconnect if it's NOT waiting for a QR scan
        const sessionObj = sessionManager.getSession(numberId);
        if (sessionObj && !sessionObj.qrCode) {
          const now = Date.now();
          const cooldown = 5 * 60 * 1000; // 5 minutes cooldown
          
          if (now - (sessionObj.lastReconnectAttempt || 0) > cooldown) {
            sessionObj.lastReconnectAttempt = now;
            logger.info(`[HEALTH] Attempting automatic reconnection/re-initialization for session ${sessionId}...`);
            // Run in background to avoid blocking health checks
            sessionManager.createSession(numberId, sessionObj.phoneNumber).catch(reconnectError => {
              logger.error(`[HEALTH] Failed to auto-reconnect session ${sessionId}:`, reconnectError);
            });
          } else {
            logger.debug(`[HEALTH] Cooldown active for auto-reconnect of session ${sessionId}. Skipping...`);
          }
        }

        return;
      }

      // Send ping to verify connection
      const sessionObj = sessionManager.getSession(numberId);

      if (!sessionObj || !sessionObj.client) {
        throw new Error('Session object not found');
      }

      // Check if client is ready (whatsapp-web.js specific)
      if (!sessionObj.isReady) {
        throw new Error('Client not ready');
      }

      // Verify the client state
      const state = await sessionObj.client.getState();
      if (state !== 'CONNECTED') {
        throw new Error(`Client state is ${state}`);
      }

      // If everything is okay, report healthy
      await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
        numberId,
        status: 'HEALTHY',
        workerId: config.worker.id,
      });

      logger.debug(`Health check passed for session ${sessionId}`);
    } catch (error) {
      logger.error(`Health check failed for session ${session.sessionId}:`, error);

      await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
        numberId: session.numberId,
        status: 'UNHEALTHY',
        reason: error.message,
      });
    }
  }

  async handleHealthCheckRequest(data) {
    const { numberId } = data;

    logger.info(`Manual health check requested for number ${numberId}`);

    const session = sessionManager.getSession(numberId);

    if (!session) {
      await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
        numberId,
        status: 'NOT_FOUND',
        reason: 'Session not found',
      });
      return;
    }

    await this.checkSession({
      numberId,
      connected: session.connected,
      sessionId: session.sessionId,
    });
  }

  getWorkerStatus() {
    const sessions = sessionManager.getActiveSessions();

    return {
      workerId: config.worker.id,
      workerName: config.worker.name,
      totalSessions: sessions.length,
      connectedSessions: sessions.filter((s) => s.connected).length,
      disconnectedSessions: sessions.filter((s) => !s.connected).length,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: Date.now(),
    };
  }

  async reportWorkerStatus() {
    const status = this.getWorkerStatus();

    logger.debug('Worker status:', status);

    await rabbitmq.publish(config.rabbitmq.queues.sessionUpdate, {
      action: 'worker_status',
      data: status,
    });
  }
}

export default new HealthHandler();