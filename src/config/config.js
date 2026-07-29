import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const config = {
  // Worker
  worker: {
    id: process.env.WORKER_ID || 'worker-1',
    name: process.env.WORKER_NAME || 'WhatsApp Worker',
  },

  // RabbitMQ
  rabbitmq: {
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@213.199.54.136:5672',
    queues: {
      messageSend: process.env.QUEUE_MESSAGE_SEND || 'whatsapp.message.send',
      messageReceive: process.env.QUEUE_MESSAGE_RECEIVE || 'whatsapp.message.receive',
      numberHealth: process.env.QUEUE_NUMBER_HEALTH || 'whatsapp.number.health',
      sessionUpdate: process.env.QUEUE_SESSION_UPDATE || 'whatsapp.session.update',
      workerEvents: process.env.QUEUE_WORKER_EVENTS || 'whatsapp.worker.events',
    },
    prefetch: 1,
  },

  // Backend API
  backend: {
    url: process.env.BACKEND_API_URL || 'http://localhost:8080/api',
    apiKey: process.env.BACKEND_API_KEY || '',
  },

  // WAHA (per-number WhatsApp HTTP API containers)
  waha: {
    image: process.env.WAHA_IMAGE || 'devlikeapro/waha:latest',
    engine: process.env.WAHA_ENGINE || 'GOWS',
    network: process.env.DOCKER_NETWORK || 'waha-network',
    // Base URL WAHA containers use to reach this worker's webhook server,
    // resolved via Docker DNS on the shared network (compose service name).
    webhookBaseUrl: process.env.WORKER_PUBLIC_URL || `http://worker:${process.env.WEBHOOK_PORT || 3001}`,
  },

  webhookServer: {
    port: parseInt(process.env.WEBHOOK_PORT) || 3001,
  },

  // WhatsApp
  whatsapp: {
    maxRetry: parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3,
    messageTimeout: parseInt(process.env.MESSAGE_TIMEOUT) || 30000,
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 60000,
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    pretty: process.env.LOG_PRETTY === 'true',
  },

  // Environment
  env: process.env.NODE_ENV || 'production',
  isDevelopment: process.env.NODE_ENV !== 'production',
  isProduction: process.env.NODE_ENV === 'production',
};

export default config;