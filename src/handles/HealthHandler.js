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
        
        return;
      }

      // Send ping to verify connection
      const sessionObj = sessionManager.getSession(numberId);
      
      if (!sessionObj || !sessionObj.sock) {
        throw new Error('Session object not found');
      }

      // Check if socket is still open
      if (sessionObj.sock.ws.readyState !== 1) { // 1 = OPEN
        throw new Error('WebSocket not open');
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