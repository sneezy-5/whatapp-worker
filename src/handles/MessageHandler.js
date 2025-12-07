import sessionManager from '../services/sessionManager.js';
import rabbitmq from '../services/rabbitMQService.js';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';

class MessageHandler {
  async handleSendMessage(data) {
    const { messageId, recipientNumber, content, type, whatsappNumberId, mediaUrl } = data;

    logger.info(`[MESSAGE HANDLER] Processing message ${messageId} to ${recipientNumber}`);
    logger.info(`[MESSAGE HANDLER] whatsappNumberId: ${whatsappNumberId} (type: ${typeof whatsappNumberId})`);

    try {
      // Convert whatsappNumberId to number if it's a string
      const numberId = typeof whatsappNumberId === 'string'
        ? parseInt(whatsappNumberId, 10)
        : whatsappNumberId;

      logger.info(`[MESSAGE HANDLER] Converted numberId: ${numberId} (type: ${typeof numberId})`);

      // Get the session for this number
      const session = sessionManager.getSession(numberId);

      if (!session) {
        logger.error(`[MESSAGE HANDLER] No session found for numberId: ${numberId}`);
        throw new Error(`No active session for number ID: ${numberId}`);
      }

      logger.info(`[MESSAGE HANDLER] Found session: ${session.sessionId}`);

      if (!session.connected) {
        logger.error(`[MESSAGE HANDLER] Session not connected: ${session.sessionId}`);
        throw new Error(`Session not connected for number ID: ${numberId}`);
      }

      logger.info(`[MESSAGE HANDLER] Session is connected and ready`);

      // Format recipient number for whatsapp-web.js (uses @c.us)
      let formattedRecipient = recipientNumber.replace(/[^0-9]/g, '');
      // whatsapp-web.js uses @c.us for individual chats
      formattedRecipient = formattedRecipient + '@c.us';

      // Send the message
      const result = await sessionManager.sendMessage(
        numberId,  // Use converted numberId
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
        error.message.includes('Session not connected') ||
        error.message.includes('Session not ready');

      // Check if it's an invalid recipient error (permanent)
      const invalidRecipient = error.code === 'INVALID_RECIPIENT' ||
        error.message.includes('not registered on WhatsApp') ||
        error.message.includes('No LID for user');

      // Send failure response to backend
      await rabbitmq.publish(config.rabbitmq.queues.messageReceive, {
        messageId,
        status: 'FAILED',
        errorMessage: error.message,
        errorCode: error.code || 'UNKNOWN',
        temporary: temporary && !invalidRecipient,
        timestamp: Date.now(),
      });

      // If it's a ban-related error, notify backend
      if (error.message.includes('banned') || error.message.includes('blocked')) {
        // Get numberId from the data since we're in the catch block
        const numberId = typeof whatsappNumberId === 'string'
          ? parseInt(whatsappNumberId, 10)
          : whatsappNumberId;

        await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
          numberId: numberId,
          status: 'BANNED',
          reason: error.message,
        });
      }

      // If it's an invalid recipient, log it clearly
      if (invalidRecipient) {
        logger.warn(`Invalid recipient for message ${messageId}: ${error.message}`);
        error.temporary = false;
      } else if (temporary) {
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