import express from 'express';
import { config } from './config/config.js';
import logger from './utils/logger.js';
import sessionManager from './services/sessionManager.js';
import rabbitmq from './services/rabbitMQService.js';

class WebhookServer {
  constructor() {
    this.server = null;
  }

  start() {
    const app = express();
    app.use(express.json({ limit: '25mb' }));

    // Endpoint de monitoring : 200 si RabbitMQ est connecté ET consomme,
    // 503 sinon. À brancher sur un healthcheck Docker / une sonde externe
    // (UptimeKuma, Prometheus blackbox, cron curl...) pour être alerté
    // AVANT de devoir redémarrer à la main.
    app.get('/health', (req, res) => {
      const rmq = rabbitmq.getStatus();
      const ok = rmq.healthy;
      res.status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'degraded',
        rabbitmq: rmq,
        uptime: process.uptime(),
        timestamp: Date.now(),
      });
    });

    app.post('/waha-webhook/:numberId', async (req, res) => {
      const numberId = parseInt(req.params.numberId, 10);
      const { event, payload, session } = req.body || {};

      // Always ack fast: WAHA retries on non-2xx, we don't want it storming us
      // while we're mid-processing (mirrors the old ack-first RabbitMQ pattern).
      res.sendStatus(200);

      try {
        logger.debug(`[WEBHOOK] numberId=${numberId} event=${event} session=${session}`);

        switch (event) {
          case 'session.status':
            await sessionManager.onSessionStatus(numberId, payload?.status);
            break;

          case 'message':
            await sessionManager.onIncomingMessage(numberId, payload);
            break;

          case 'message.ack':
            await sessionManager.onMessageAck(numberId, payload);
            break;

          default:
            logger.debug(`[WEBHOOK] Ignoring unhandled event: ${event}`);
        }
      } catch (error) {
        logger.error(`[WEBHOOK] Error handling event for numberId ${numberId}:`, error);
      }
    });

    this.server = app.listen(config.webhookServer.port, () => {
      logger.info(`Webhook server listening on port ${config.webhookServer.port}`);
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

export default new WebhookServer();
