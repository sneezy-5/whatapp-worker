import amqp from 'amqplib';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';

class RabbitMQService {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.connected = false;
    this.reconnecting = false;
  }

  async connect() {
    try {
      logger.info('Connecting to RabbitMQ...');
      this.connection = await amqp.connect(config.rabbitmq.url);
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
      logger.info('RabbitMQ connected and queues declared');

      // Auto-reconnect
      this.connection.on('close', () => this.handleClose());
      this.connection.on('error', (err) => this.handleError(err));

    } catch (error) {
      logger.error('Failed to connect RabbitMQ:', error);
      throw error;
    }
  }

  async consume(queue, handler) {
    if (!this.connected) throw new Error("RabbitMQ not connected");

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

          if (error.temporary) {
            this.channel.nack(msg, false, true);
          } else {
            this.channel.nack(msg, false, false);
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
    if (!this.connected) throw new Error("RabbitMQ not connected");

    const content = Buffer.from(JSON.stringify(data));

    this.channel.sendToQueue(queue, content, {
      persistent: true,
    });

    logger.debug(`Message sent to ${queue}`);
  }

  async close() {
    try {
      if (this.channel) await this.channel.close();
      if (this.connection) await this.connection.close();
      this.connected = false;
      logger.info('RabbitMQ closed');
    } catch (err) {
      logger.error('Error closing RabbitMQ', err);
    }
  }

  async handleClose() {
    logger.warn("RabbitMQ closed, reconnecting in 5s");
    this.connected = false;

    if (!this.reconnecting) {
      this.reconnecting = true;
      setTimeout(() => {
        this.reconnecting = false;
        this.connect();
      }, 5000);
    }
  }

  handleError(err) {
    logger.error("RabbitMQ connection error:", err);
  }
}

export default new RabbitMQService();
