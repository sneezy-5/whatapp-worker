import amqp from 'amqplib';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';

class RabbitMQService {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.connected = false;
    this.reconnecting = false;
    // On mémorise chaque consumer enregistré pour pouvoir le REJOUER à chaque
    // reconnexion. Sans ça, après une coupure RabbitMQ la connexion revient
    // mais plus personne ne consomme les queues → il fallait redémarrer le
    // service à la main.
    this.consumers = [];
    // Flag pour distinguer un close() volontaire (shutdown) d'une coupure subie.
    this.closing = false;
    // Timestamp de la dernière connexion réussie / dernière coupure (monitoring).
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.reconnectAttempts = 0;
  }

  async connect() {
    this.closing = false;

    logger.info('Connecting to RabbitMQ...');

    this.connection = await amqp.connect(config.rabbitmq.url, {
      heartbeat: config.rabbitmq.heartbeat,
    });
    this.channel = await this.connection.createChannel();

    // Prefetch BEFORE consumers start
    await this.channel.prefetch(config.rabbitmq.prefetch || 1);

    // Declare exchange
    await this.channel.assertExchange('whatsapp.exchange', 'direct', {
      durable: true,
    });

    // Declare queues
    const queues = config.rabbitmq.queues;

    for (const key in queues) {
      await this.channel.assertQueue(queues[key], { durable: true });
    }

    // Bind queues
    await this.channel.bindQueue(
      queues.sessionUpdate,
      'whatsapp.exchange',
      'session.update'
    );

    await this.channel.bindQueue(
      queues.messageSend,
      'whatsapp.exchange',
      'message.send'
    );

    await this.channel.bindQueue(
      queues.messageReceive,
      'whatsapp.exchange',
      'message.receive'
    );

    await this.channel.bindQueue(
      queues.numberHealth,
      'whatsapp.exchange',
      'number.health'
    );

    this.connected = true;
    this.lastConnectedAt = Date.now();
    this.reconnectAttempts = 0;
    logger.info('RabbitMQ connected and queues declared');

    // Auto-reconnect : on écoute connection ET channel.
    this.connection.on('close', () => this.handleClose());
    this.connection.on('error', (err) => this.handleError(err));
    this.connection.on('blocked', (reason) =>
      logger.warn(`RabbitMQ connection blocked by broker: ${reason}`)
    );
    this.connection.on('unblocked', () =>
      logger.info('RabbitMQ connection unblocked by broker')
    );
    this.channel.on('close', () =>
      logger.warn('RabbitMQ channel closed')
    );
    this.channel.on('error', (err) =>
      logger.error('RabbitMQ channel error:', err)
    );

    // ✅ REJEU DES CONSUMERS : indispensable après une reconnexion.
    await this.replayConsumers();
  }

  async replayConsumers() {
    if (this.consumers.length === 0) return;

    logger.info(`Re-registering ${this.consumers.length} consumer(s) after (re)connect`);

    for (const { queue, handler } of this.consumers) {
      await this.registerConsumer(queue, handler);
    }
  }

  async consume(queue, handler) {
    // On garde la définition en mémoire pour les reconnexions futures,
    // sans doublon si la même queue est réenregistrée.
    const existing = this.consumers.find((c) => c.queue === queue);
    if (existing) {
      existing.handler = handler;
    } else {
      this.consumers.push({ queue, handler });
    }

    if (!this.connected || !this.channel) {
      logger.warn(`RabbitMQ not connected yet, consumer for ${queue} will start on connect`);
      return;
    }

    await this.registerConsumer(queue, handler);
  }

  async registerConsumer(queue, handler) {
    logger.info(`Starting consumer on ${queue}`);

    await this.channel.consume(
      queue,
      async (msg) => {
        if (!msg) return;

        try {
          const content = JSON.parse(msg.content.toString());
          await handler(content);
          this.channel.ack(msg);

        } catch (error) {
          // ✅ LOGS DÉTAILLÉS POUR DEBUG
          console.error('\n========================================');
          console.error(`❌ ERREUR DANS CONSUMER ${queue}`);
          console.error('========================================');
          console.error('Type d\'erreur:', error.constructor.name);
          console.error('Message:', error.message);
          console.error('Stack:', error.stack);
          console.error('Contenu du message:', msg.content.toString());
          console.error('========================================\n');

          logger.error(`Error processing ${queue}:`, {
            error: error.message,
            stack: error.stack,
            messageContent: msg.content.toString()
          });

          // Un nack sur un channel déjà mort lève une exception : on protège.
          try {
            if (error.temporary) {
              this.channel.nack(msg, false, true);
            } else {
              this.channel.nack(msg, false, false);
            }
          } catch (nackError) {
            logger.error(`Failed to nack message on ${queue}:`, nackError.message);
          }
        }
      },
      {
        noAck: false,
        consumerTag: `worker-${queue}-${process.pid}`, // custom ID 👌
      }
    );

    logger.info(`Consumer ready → ${queue}`);
  }

  async publish(queue, data) {
    if (!this.connected || !this.channel) {
      logger.warn(`RabbitMQ not connected, dropping message for ${queue}`);
      return;
    }

    const content = Buffer.from(JSON.stringify(data));

    try {
      this.channel.sendToQueue(queue, content, {
        persistent: true,
      });
      logger.debug(`Message sent to ${queue}`);
    } catch (error) {
      logger.error(`Failed to publish to ${queue}:`, error.message);
    }
  }

  async close() {
    this.closing = true;
    try {
      if (this.channel) await this.channel.close();
      if (this.connection) await this.connection.close();
      this.connected = false;
      logger.info('RabbitMQ closed');
    } catch (err) {
      logger.error('Error closing RabbitMQ', err);
    } finally {
      this.channel = null;
      this.connection = null;
    }
  }

  handleClose() {
    if (this.connected) {
      this.lastDisconnectedAt = Date.now();
    }
    this.connected = false;
    this.channel = null;
    this.connection = null;

    if (this.closing) {
      logger.info('RabbitMQ connection closed (intentional shutdown)');
      return;
    }

    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;

    const { reconnectMinDelay, reconnectMaxDelay } = config.rabbitmq;
    // Backoff exponentiel borné : 2s, 4s, 8s ... plafonné à 30s. Jamais d'abandon.
    const delay = Math.min(
      reconnectMinDelay * 2 ** this.reconnectAttempts,
      reconnectMaxDelay
    );
    this.reconnectAttempts += 1;

    logger.warn(`RabbitMQ down — reconnecting in ${delay}ms (attempt #${this.reconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this.connect();
        this.reconnecting = false;
        logger.info('RabbitMQ reconnected successfully');
      } catch (err) {
        this.reconnecting = false;
        logger.error(`RabbitMQ reconnect attempt #${this.reconnectAttempts} failed:`, err.message);
        // On relance une tentative : la boucle ne s'arrête jamais tant que
        // ce n'est pas un shutdown volontaire.
        if (!this.closing) this.scheduleReconnect();
      }
    }, delay);
  }

  handleError(err) {
    logger.error('RabbitMQ connection error:', err.message || err);
    // Pas de reconnexion ici : 'error' est toujours suivi de 'close' qui la gère.
  }

  // Pour le monitoring (endpoint /health).
  isHealthy() {
    return this.connected && this.channel !== null;
  }

  getStatus() {
    return {
      connected: this.connected,
      healthy: this.isHealthy(),
      reconnecting: this.reconnecting,
      reconnectAttempts: this.reconnectAttempts,
      consumers: this.consumers.map((c) => c.queue),
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
    };
  }
}

export default new RabbitMQService();
