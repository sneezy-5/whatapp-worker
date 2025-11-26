import sessionManager from '../services/sessionManager.js';
import rabbitmq from '../services/rabbitmq.js';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';

class MessageHandler {
  async handleSendMessage(data) {
    const { messageId, recipientNumber, content, type, whatsappNumberId, mediaUrl } = data;

    logger.info(`Processing message ${messageId} to ${recipientNumber}`);

    try {
      // Get the session for this number
      const session = sessionManager.getSession(whatsappNumberId);

      if (!session) {
        throw new Error(`No active session for number ID: ${whatsappNumberId}`);
      }

      if (!session.connected) {
        throw new Error(`Session not connected for number ID: ${whatsappNumberId}`);
      }

      // Format recipient number (ensure it has country code and @s.whatsapp.net)
      let formattedRecipient = recipientNumber.replace(/[^0-9]/g, '');
      if (!formattedRecipient.startsWith('+')) {
        formattedRecipient = '+' + formattedRecipient;
      }
      formattedRecipient = formattedRecipient.replace('+', '') + '@s.whatsapp.net';

      // Send the message
      const result = await sessionManager.sendMessage(
        whatsappNumberId,
        formattedRecipient,
        content,
        type,
        mediaUrl
      );

      // Send success response to backend
      await rabbitmq.publish(config.rabbitmq.queues.messageReceive, {
        messageId,
        status: 'SENT',
        whatsappMessageId: result.messageId,
        timestamp: Date.now(),
      });

      logger.info(`Message ${messageId} sent successfully`);
    } catch (error) {
      logger.error(`Failed to send message ${messageId}:`, error);

      // Check if it's a temporary error (network issue, etc.)
      const temporary = error.message.includes('ECONNREFUSED') || 
                       error.message.includes('ETIMEDOUT') ||
                       error.message.includes('Session not connected');

      // Send failure response to backend
      await rabbitmq.publish(config.rabbitmq.queues.messageReceive, {
        messageId,
        status: 'FAILED',
        errorMessage: error.message,
        timestamp: Date.now(),
      });

      // If it's a ban-related error, notify backend
      if (error.message.includes('banned') || error.message.includes('blocked')) {
        await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
          numberId: whatsappNumberId,
          status: 'BANNED',
          reason: error.message,
        });
      }

      if (temporary) {
        error.temporary = true;
      }

      throw error;
    }
  }

  async handleMessageStatus(data) {
    const { messageId, status } = data;

    logger.info(`Message ${messageId} status: ${status}`);

    // Forward status update to backend
    await rabbitmq.publish(config.rabbitmq.queues.messageReceive, {
      messageId,
      status,
      timestamp: Date.now(),
    });
  }

  async handleBulkMessages(messages) {
    logger.info(`Processing bulk messages: ${messages.length} messages`);

    const results = [];

    for (const message of messages) {
      try {
        await this.handleSendMessage(message);
        results.push({ messageId: message.messageId, success: true });
      } catch (error) {
        results.push({
          messageId: message.messageId,
          success: false,
          error: error.message,
        });
      }
    }

    return results;
  }
}

export default new MessageHandler();