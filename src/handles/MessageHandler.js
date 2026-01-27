import sessionManager from '../services/sessionManager.js';
import rabbitmq from '../services/rabbitMQService.js';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';

class MessageHandler {

  /**
   * Format Ivory Coast numbers to handle old format (8 digits) vs new format (10 digits)
   * In 2021, Ivory Coast migrated from 8 digits to 10 digits by adding prefixes:
   * - 01, 02, 03 for Moov
   * - 05 for MTN
   * - 07 for Orange
   * 
   * This function returns all possible formats to try
   */
  getIvoryCoastNumberVariants(phoneNumber) {
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    const variants = [];

    // Check if it's an Ivory Coast number (starts with 225)
    if (!cleaned.startsWith('225')) {
      return [cleaned]; // Not Ivory Coast, return as-is
    }

    const withoutCountryCode = cleaned.substring(3); // Remove 225

    // New format: 225 + 10 digits (e.g., 2250709865432)
    if (withoutCountryCode.length === 10) {
      // Already in new format, but also try without the prefix
      variants.push(cleaned);

      // Also try without the new prefix (old format)
      if (withoutCountryCode.startsWith('01') ||
        withoutCountryCode.startsWith('05') ||
        withoutCountryCode.startsWith('07')) {
        const oldFormat = '225' + withoutCountryCode.substring(2);
        variants.push(oldFormat);
      }
    }
    // Old format: 225 + 8 digits (e.g., 22509865432)
    else if (withoutCountryCode.length === 8) {
      // Original old format
      variants.push(cleaned);

      // Try with new prefixes (01, 05, 07)
      const prefixes = ['07', '05', '01']; // Most common first
      for (const prefix of prefixes) {
        variants.push('225' + prefix + withoutCountryCode);
      }
    }
    else {
      // Unknown format, return as-is
      variants.push(cleaned);
    }

    logger.info(`[IVORY COAST] Number variants for ${phoneNumber}: ${variants.join(', ')}`);
    return variants;
  }

  async handleSendMessage(data) {
    let { messageId, recipientNumber, content, type, whatsappNumberId, mediaUrl } = data;

    // Sanitize recipient number (remove spaces, newlines, etc)
    if (recipientNumber) {
      recipientNumber = recipientNumber.replace(/\s/g, '').trim();
    }

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

      // Get all number variants (for Ivory Coast old/new format handling)
      const numberVariants = this.getIvoryCoastNumberVariants(recipientNumber);

      let result = null;
      let lastError = null;
      let successfulNumber = null;

      // Try each variant until one works
      for (const variant of numberVariants) {
        const formattedRecipient = variant + '@c.us';

        try {
          logger.info(`[MESSAGE HANDLER] Trying to send to: ${formattedRecipient}`);

          result = await sessionManager.sendMessage(
            numberId,
            formattedRecipient,
            content,
            type,
            mediaUrl
          );

          successfulNumber = formattedRecipient;
          logger.info(`[MESSAGE HANDLER] ✅ Message sent successfully to ${formattedRecipient}`);
          break; // Success, exit loop

        } catch (error) {
          const errorMessage = error.message || '';
          const isMarkedUnreadError = /markedUnread/i.test(errorMessage) ||
            /markedUnread/i.test(String(error)) ||
            (error.stack && /markedUnread/i.test(error.stack));

          if (isMarkedUnreadError) {
            logger.warn(`[MESSAGE HANDLER] Ignoring markedUnread error for ${formattedRecipient}. Treating as success.`);
            result = {
              success: true,
              messageId: 'UNKNOWN_ID',
              warning: 'markedUnread'
            };
            successfulNumber = formattedRecipient;
            break; // Message likely sent, stop trying variants
          }

          logger.warn(`[MESSAGE HANDLER] Failed to send to ${formattedRecipient}: ${errorMessage}`);
          lastError = error;

          // If it's not a registration-related error (which would justify trying other variants),
          // throw it immediately to avoid unnecessary retries.
          if (!errorMessage.includes('not registered') &&
            !errorMessage.includes('No LID for user') &&
            error.code !== 'INVALID_RECIPIENT') {
            throw error;
          }
        }
      }

      // If no variant worked, throw the last error
      if (!result) {
        throw lastError || new Error(`Failed to send message to any number variant`);
      }

      // Send success response to backend
      logger.info(`[MESSAGE HANDLER] 📤 Publishing SUCCESS/SENT status for message ${messageId} to queue: ${config.rabbitmq.queues.messageReceive}`);

      try {
        await rabbitmq.publish(config.rabbitmq.queues.messageReceive, {
          messageId,
          status: 'SENT',
          whatsappMessageId: result.messageId || 'UNKNOWN',
          timestamp: Date.now(),
        });
        logger.info(`[MESSAGE HANDLER] ✅ Successfully published SENT status for ${messageId}`);
      } catch (pubError) {
        logger.error(`[MESSAGE HANDLER] ❌ Failed to publish SENT status for ${messageId}:`, pubError);
      }

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