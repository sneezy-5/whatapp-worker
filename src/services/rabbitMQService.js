import amqp from 'amqplib';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';

class RabbitMQService {
  constructor() {
    this.connection = null;
    this.channel = null;
    this.connected = false;
  }

  async connect() {
    try {
      logger.info('Connecting to RabbitMQ...');
      
      this.connection = await amqp.connect(config.rabbitmq.url);
      this.channel = await this.connection.createChannel();
      
      await this.channel.prefetch(config.rabbitmq.prefetch);
      
      // Declare queues
      await this.channel.assertQueue(config.rabbitmq.queues.messageSend, { durable: true });
      await this.channel.assertQueue(config.rabbitmq.queues.messageReceive, { durable: true });
      await this.channel.assertQueue(config.rabbitmq.queues.numberHealth, { durable: true });
      await this.channel.assertQueue(config.rabbitmq.queues.sessionUpdate, { durable: true });
      
      this.connected = true;
      logger.info('Connected to RabbitMQ successfully');
      
      // Handle connection errors
      this.connection.on('error', (err) => {
        logger.error('RabbitMQ connection error:', err);
        this.connected = false;
      });
      
      this.connection.on('close', () => {
        logger.warn('RabbitMQ connection closed');
        this.connected = false;
        setTimeout(() => this.connect(), 5000); // Reconnect after 5s
      });
      
    } catch (error) {
      logger.error('Failed to connect to RabbitMQ:', error);
      this.connected = false;
      setTimeout(() => this.connect(), 5000); // Retry after 5s
    }
  }

  async consume(queue, handler) {
    if (!this.connected || !this.channel) {
      throw new Error('RabbitMQ not connected');
    }

    logger.info(`Starting to consume queue: ${queue}`);

    await this.channel.consume(
      queue,
      async (msg) => {
        if (!msg) return;

        try {
          const content = JSON.parse(msg.content.toString());
          logger.debug(`Received message from ${queue}:`, content);
          
          await handler(content);
          
          this.channel.ack(msg);
        } catch (error) {
          logger.error(`Error processing message from ${queue}:`, error);
          
          // Requeue the message if it's a temporary error
          if (error.temporary) {
            this.channel.nack(msg, false, true);
          } else {
            this.channel.nack(msg, false, false);
          }
        }
      },
      { noAck: false }
    );
  }

  async publish(queue, data) {
    if (!this.connected || !this.channel) {
      throw new Error('RabbitMQ not connected');
    }

    const content = Buffer.from(JSON.stringify(data));
    
    this.channel.sendToQueue(queue, content, { persistent: true });
    
    logger.debug(`Published message to ${queue}:`, data);
  }

  async close() {
    try {
      if (this.channel) {
        await this.channel.close();
      }
      if (this.connection) {
        await this.connection.close();
      }
      this.connected = false;
      logger.info('RabbitMQ connection closed');
    } catch (error) {
      logger.error('Error closing RabbitMQ connection:', error);
    }
  }
}

export default new RabbitMQService();