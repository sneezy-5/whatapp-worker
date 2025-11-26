import axios from 'axios';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';

/**
 * Service for communicating with the Backend API
 */
class BackendApiService {
  constructor() {
    this.baseUrl = config.backend.url;
    this.apiKey = config.backend.apiKey;
    
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-ID': config.worker.id,
      },
    });

    // Add request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        logger.debug(`API Request: ${config.method.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        logger.error('API Request Error:', error);
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(`API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        logger.error('API Response Error:', error.message);
        return Promise.reject(error);
      }
    );
  }

  async registerWorker() {
    try {
      const response = await this.client.post('/workers/register', {
        workerId: config.worker.id,
        workerName: config.worker.name,
      });

      logger.info('Worker registered with backend');
      return response.data;
    } catch (error) {
      logger.error('Failed to register worker:', error.message);
      throw error;
    }
  }

  async updateWorkerStatus(status) {
    try {
      await this.client.post('/workers/status', {
        workerId: config.worker.id,
        status,
        timestamp: Date.now(),
      });

      logger.debug(`Worker status updated: ${status}`);
    } catch (error) {
      logger.error('Failed to update worker status:', error.message);
    }
  }

  async reportSessionStatus(numberId, status, details = {}) {
    try {
      await this.client.post('/sessions/status', {
        numberId,
        workerId: config.worker.id,
        status,
        details,
        timestamp: Date.now(),
      });

      logger.debug(`Session status reported for number ${numberId}: ${status}`);
    } catch (error) {
      logger.error('Failed to report session status:', error.message);
    }
  }

  async reportMessageStatus(messageId, status, errorMessage = null) {
    try {
      await this.client.post('/messages/status', {
        messageId,
        status,
        errorMessage,
        timestamp: Date.now(),
      });

      logger.debug(`Message status reported: ${messageId} -> ${status}`);
    } catch (error) {
      logger.error('Failed to report message status:', error.message);
    }
  }

  async getNumberInfo(numberId) {
    try {
      const response = await this.client.get(`/numbers/${numberId}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to get number info for ${numberId}:`, error.message);
      return null;
    }
  }

  async reportError(error, context = {}) {
    try {
      await this.client.post('/errors/report', {
        workerId: config.worker.id,
        error: {
          message: error.message,
          stack: error.stack,
          code: error.code,
        },
        context,
        timestamp: Date.now(),
      });

      logger.debug('Error reported to backend');
    } catch (err) {
      logger.error('Failed to report error to backend:', err.message);
    }
  }

  async heartbeat() {
    try {
      await this.client.post('/workers/heartbeat', {
        workerId: config.worker.id,
        timestamp: Date.now(),
      });

      logger.debug('Heartbeat sent to backend');
    } catch (error) {
      logger.warn('Failed to send heartbeat:', error.message);
    }
  }
}

export default new BackendApiService();