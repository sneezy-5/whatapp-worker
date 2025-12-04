import { config } from './config/config.js';
import logger from './utils/logger.js';
import rabbitmq from './services/rabbitmq.js';
import sessionManager from './services/sessionManager.js';
import messageHandler from './handlers/messageHandler.js';
import healthHandler from './handlers/healthHandler.js';

class WhatsAppWorker {
  constructor() {
    this.isRunning = false;
  }

  async start() {
    try {
      logger.info(`Starting WhatsApp Worker: ${config.worker.name} (${config.worker.id})`);
      logger.info(`Environment: ${config.env}`);

      // Connect to RabbitMQ
      await rabbitmq.connect();
      logger.info('RabbitMQ connected');

      // Start consuming messages
      await this.setupConsumers();

      // Start health checks
      healthHandler.startHealthChecks();

      // Report worker status periodically
      setInterval(async () => {
        await healthHandler.reportWorkerStatus();
      }, 30000); // Every 30 seconds

      this.isRunning = true;
      logger.info('Worker started successfully and ready to process messages');

    } catch (error) {
      logger.error('Failed to start worker:', error);
      process.exit(1);
    }
  }

  async setupConsumers() {
    // Consumer for message sending
    await rabbitmq.consume(
      config.rabbitmq.queues.messageSend,
      async (data) => {
        await messageHandler.handleSendMessage(data);
      }
    );

    // Consumer for health checks
    await rabbitmq.consume(
      config.rabbitmq.queues.numberHealth,
      async (data) => {
        if (data.action === 'health_check') {
          await healthHandler.handleHealthCheckRequest(data);
        }
      }
    );

    // Consumer for session updates
    await rabbitmq.consume(
      config.rabbitmq.queues.sessionUpdate,
      async (data) => {
        await this.handleSessionUpdate(data);
      }
    );

    logger.info('All message consumers set up successfully');
  }

  async handleSessionUpdate(data) {
    const { action, numberId, phoneNumber } = data;

    logger.info(`Session update: ${action} for number ${numberId}`);

    switch (action) {
      case 'create':
        await sessionManager.createSession(numberId, phoneNumber);
        break;

      case 'close':
        const session = sessionManager.getSession(numberId);
        if (session) {
          await sessionManager.closeSession(session.sessionId);
        }
        break;

      case 'reconnect':
        const existingSession = sessionManager.getSession(numberId);
        if (existingSession) {
          await sessionManager.closeSession(existingSession.sessionId);
        }
        await sessionManager.createSession(numberId, phoneNumber);
        break;

      default:
        logger.warn(`Unknown session action: ${action}`);
    }
  }

  async shutdown() {
    logger.info('Shutting down worker...');

    this.isRunning = false;

    // Stop health checks
    healthHandler.stopHealthChecks();

    // Close all WhatsApp sessions
    await sessionManager.closeAllSessions();

    // Close RabbitMQ connection
    await rabbitmq.close();

    logger.info('Worker shut down successfully');
    process.exit(0);
  }
}

// Create worker instance
const worker = new WhatsAppWorker();

// Start the worker
worker.start();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal');
  await worker.shutdown();
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal');
  await worker.shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  worker.shutdown();
});

export default worker;