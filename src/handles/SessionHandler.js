import sessionManager from '../services/sessionManager.js';
import logger from '../utils/logger.js';

/**
 * Handler for session-related operations
 */
class SessionHandler {
  async handleCreateSession(data) {
    const { numberId, phoneNumber, sessionId } = data;

    logger.info(`Creating session for number ${numberId}: ${phoneNumber}`);

    try {
      await sessionManager.createSession(numberId, phoneNumber);
      
      logger.info(`✅ Session created for number ${numberId}`);
      return { success: true, sessionId };
    } catch (error) {
      logger.error(`Failed to create session for number ${numberId}:`, error);
      throw error;
    }
  }

  async handleCloseSession(data) {
    const { numberId } = data;

    logger.info(`Closing session for number ${numberId}`);

    try {
      const session = sessionManager.getSession(numberId);
      
      if (session) {
        await sessionManager.closeSession(session.sessionId);
        logger.info(`✅ Session closed for number ${numberId}`);
      } else {
        logger.warn(`No session found for number ${numberId}`);
      }

      return { success: true };
    } catch (error) {
      logger.error(`Failed to close session for number ${numberId}:`, error);
      throw error;
    }
  }

  async handleReconnectSession(data) {
    const { numberId, phoneNumber } = data;

    logger.info(`Reconnecting session for number ${numberId}`);

    try {
      // Close existing session
      const existingSession = sessionManager.getSession(numberId);
      if (existingSession) {
        await sessionManager.closeSession(existingSession.sessionId);
      }

      // Create new session
      await sessionManager.createSession(numberId, phoneNumber);
      
      logger.info(`✅ Session reconnected for number ${numberId}`);
      return { success: true };
    } catch (error) {
      logger.error(`Failed to reconnect session for number ${numberId}:`, error);
      throw error;
    }
  }

  getSessionStatus(numberId) {
    const session = sessionManager.getSession(numberId);

    if (!session) {
      return {
        exists: false,
        message: `No session found for number ${numberId}`,
      };
    }

    return {
      exists: true,
      sessionId: session.sessionId,
      numberId: session.numberId,
      phoneNumber: session.phoneNumber,
      connected: session.connected,
      hasQR: !!session.qrCode,
    };
  }

  getAllSessionsStatus() {
    const sessions = sessionManager.getActiveSessions();

    return sessions.map((session) => ({
      sessionId: session.sessionId,
      numberId: session.numberId,
      phoneNumber: session.phoneNumber,
      connected: session.connected,
    }));
  }
}

export default new SessionHandler();