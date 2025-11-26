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
    url: process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672',
    queues: {
      messageSend: process.env.QUEUE_MESSAGE_SEND || 'whatsapp.message.send',
      messageReceive: process.env.QUEUE_MESSAGE_RECEIVE || 'whatsapp.message.receive',
      numberHealth: process.env.QUEUE_NUMBER_HEALTH || 'whatsapp.number.health',
      sessionUpdate: process.env.QUEUE_SESSION_UPDATE || 'whatsapp.session.update',
    },
    prefetch: 1,
  },

  // Backend API
  backend: {
    url: process.env.BACKEND_API_URL || 'http://localhost:8080/api',
    apiKey: process.env.BACKEND_API_KEY || '',
  },

  // Sessions
  sessions: {
    dir: process.env.SESSION_DIR || join(__dirname, '../../sessions'),
    timeout: parseInt(process.env.SESSION_TIMEOUT) || 3600000, // 1 hour
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
  env: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV !== 'production',
  isProduction: process.env.NODE_ENV === 'production',
};

export default config;