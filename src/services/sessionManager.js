import { config } from '../config/config.js';
import logger from '../utils/logger.js';
import rabbitmq from '../services/rabbitMQService.js';
import dockerManager from './dockerManager.js';
import wahaClient from './wahaClient.js';

class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async createSession(numberId, phoneNumber, { force = false } = {}) {
    const cleanPhoneNumber = phoneNumber.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessionId = `session_${numberId}_${cleanPhoneNumber}`;

    logger.info(`[CREATE SESSION] Request for numberId: ${numberId}, phone: ${phoneNumber}`);

    const existingSession = this.sessions.get(sessionId);

    if (existingSession) {
      if (existingSession.connected && existingSession.isReady && !force) {
        logger.warn(`[CREATE SESSION] Session ${sessionId} already exists and is connected, returning existing session`);
        return existingSession;
      }
      if (existingSession.sendInProgress > 0) {
        logger.warn(`[CREATE SESSION] Session ${sessionId} has a send in progress, skipping recreation this cycle`);
        return existingSession;
      }
    }

    logger.info(`[CREATE SESSION] Ensuring WAHA container for ${sessionId}`);

    const { name: containerName, baseUrl } = await dockerManager.ensureContainer(numberId, phoneNumber);

    const session = existingSession || {
      sessionId,
      numberId,
      phoneNumber,
      connected: false,
      isReady: false,
      qrCode: null,
      disconnectedSince: Date.now(),
      lastReconnectAttempt: Date.now(),
      sendInProgress: 0,
    };
    session.containerName = containerName;
    session.baseUrl = baseUrl;

    this.sessions.set(sessionId, session);

    try {
      await wahaClient.startSession(baseUrl);

      // Seed current state immediately instead of waiting for the next
      // webhook - the container may already be WORKING (e.g. after a
      // worker restart) and webhooks only fire on state *changes*.
      const status = await wahaClient.getStatus(baseUrl);
      await this.onSessionStatus(numberId, status);
    } catch (error) {
      logger.error({ err: error }, `[CREATE SESSION] Failed to start WAHA session for ${sessionId}`);
      throw error;
    }

    return session;
  }

  async closeSession(numberId, deleteFiles = false) {
    const session = this.getSession(numberId);
    logger.info(`[CLOSE SESSION] Closing session for numberId ${numberId} (deleteFiles: ${deleteFiles})`);

    if (deleteFiles) {
      await dockerManager.removeContainer(numberId, { removeVolume: true });
    } else {
      await dockerManager.stopContainer(numberId);
    }

    if (session) {
      this.sessions.delete(session.sessionId);
    }
  }

  async sendMessage(numberId, recipient, content, type = 'text', mediaUrl = null) {
    const session = this.getSession(numberId);

    if (!session) {
      throw new Error(`Session not found for number ID: ${numberId}`);
    }

    if (!session.connected || !session.isReady) {
      throw new Error(`Session not ready for number ID: ${numberId}. Status: connected=${session.connected}, ready=${session.isReady}`);
    }

    session.sendInProgress = (session.sendInProgress || 0) + 1;

    logger.info(`Sending ${type} message to ${recipient} via ${session.containerName}`);

    try {
      let result;
      switch (type.toLowerCase()) {
        case 'text':
          result = await wahaClient.sendText(session.baseUrl, { chatId: recipient, text: content });
          break;

        case 'image':
          if (!mediaUrl) throw new Error('Media URL is required for image messages');
          result = await wahaClient.sendImage(session.baseUrl, { chatId: recipient, mediaUrl, caption: content });
          break;

        case 'video':
          if (!mediaUrl) throw new Error('Media URL is required for video messages');
          result = await wahaClient.sendVideo(session.baseUrl, { chatId: recipient, mediaUrl, caption: content });
          break;

        case 'document':
          if (!mediaUrl) throw new Error('Media URL is required for document messages');
          result = await wahaClient.sendFile(session.baseUrl, { chatId: recipient, mediaUrl, caption: content });
          break;

        case 'audio':
          if (!mediaUrl) throw new Error('Media URL is required for audio messages');
          result = await wahaClient.sendVoice(session.baseUrl, { chatId: recipient, mediaUrl });
          break;

        default:
          throw new Error(`Unsupported message type: ${type}`);
      }

      logger.info(`Message sent successfully to ${recipient}`);

      return {
        success: true,
        // null (not a sentinel string): whatsapp_message_id has a unique DB
        // constraint on the backend, a fixed placeholder would collide across
        // messages that all lack a real WAHA id.
        messageId: result?.id?.id || result?.id || null,
      };
    } catch (error) {
      const apiMessage = error.response?.data?.message || error.response?.data?.error;
      if (apiMessage) {
        const wrapped = new Error(apiMessage);
        wrapped.code = error.code;
        logger.error(`Error sending message to ${recipient}:`, wrapped);
        throw wrapped;
      }
      logger.error(`Error sending message to ${recipient}:`, error);
      throw error;
    } finally {
      session.sendInProgress = Math.max(0, (session.sendInProgress || 1) - 1);
    }
  }

  getSession(numberId) {
    return Array.from(this.sessions.values()).find((s) => s.numberId === numberId);
  }

  getActiveSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      numberId: s.numberId,
      phoneNumber: s.phoneNumber,
      connected: s.connected,
      isReady: s.isReady,
      disconnectedSince: s.disconnectedSince,
    }));
  }

  resetQrRetries(numberId) {
    logger.info(`QR retry counter reset for number ${numberId}`);
  }

  async closeAllSessions() {
    logger.info('Closing all sessions...');
    for (const session of this.sessions.values()) {
      await this.closeSession(session.numberId);
    }
  }

  async cleanInactiveSessions() {
    // Long enough that HealthHandler's auto-reconnect (5 min cooldown between
    // attempts) gets a real chance to recover the session before it's wiped
    // - at 1 minute this used to fire on the very first health-check tick
    // after any disconnect, deleting the container (and its session/auth
    // volume) before reconnect logic - or a human debugging the failure -
    // ever got a look in.
    const inactivityThresholdMs = 10 * 60 * 1000;
    const now = Date.now();

    for (const session of this.sessions.values()) {
      // Still waiting on the initial QR scan: not "inactive", just not yet
      // scanned. Deleting it here would yank the QR out from under whoever
      // is about to scan it.
      if (session.qrCode) continue;

      if (!session.connected && session.disconnectedSince && !(session.sendInProgress > 0)) {
        const inactiveTime = now - session.disconnectedSince;
        if (inactiveTime > inactivityThresholdMs) {
          logger.warn(`[CLEANUP] Session ${session.sessionId} has been disconnected for more than ${inactivityThresholdMs / 60000} minutes. Deleting...`);

          const { numberId, sessionId } = session;
          await this.closeSession(numberId, true);

          try {
            await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
              action: 'deleted_inactivity',
              numberId,
              sessionId,
              timestamp: Date.now(),
            });

            await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
              numberId,
              status: 'DISCONNECTED',
              reason: 'Deleted due to 1 minute inactivity',
            });
          } catch (pubError) {
            logger.error(`[CLEANUP] Failed to publish inactivity deletion events for ${sessionId}:`, pubError);
          }
        }
      }
    }
  }

  async restoreSessions() {
    logger.info('[RESTORE] Starting automatic session restoration from Docker...');

    const containers = await dockerManager.listManagedContainers();
    logger.info(`[RESTORE] Found ${containers.length} managed WAHA container(s)`);

    let restored = 0;
    let failed = 0;

    for (const { numberId, phoneNumber } of containers) {
      if (!phoneNumber) {
        logger.warn(`[RESTORE] Container for numberId ${numberId} has no phoneNumber label, skipping`);
        continue;
      }
      try {
        logger.info(`[RESTORE] Restoring session for numberId: ${numberId}, phone: ${phoneNumber}...`);
        await this.createSession(numberId, phoneNumber);
        restored++;
      } catch (error) {
        logger.error(`[RESTORE] Failed to restore session for numberId ${numberId}:`, error.message);
        failed++;
      }
    }

    logger.info(`[RESTORE] Restoration complete: ${restored} restored, ${failed} failed`);
  }

  /**
   * Called by the webhook server when a WAHA container reports a
   * session.status change.
   */
  async onSessionStatus(numberId, status) {
    const session = this.getSession(numberId);
    if (!session) {
      logger.warn(`[WEBHOOK] Received status ${status} for unknown numberId ${numberId}`);
      return;
    }

    const { sessionId } = session;
    logger.info(`[STATUS] ${sessionId} -> ${status}`);

    switch (status) {
      case 'SCAN_QR_CODE': {
        try {
          const qrCode = await wahaClient.getQrBase64(session.baseUrl);
          session.qrCode = qrCode;

          await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
            action: 'qr_generated',
            numberId,
            sessionId,
            qrCode,
            timestamp: Date.now(),
          });
        } catch (error) {
          logger.error(`Error fetching QR code for ${sessionId}:`, error);
        }
        break;
      }

      case 'WORKING': {
        session.connected = true;
        session.isReady = true;
        session.qrCode = null;
        session.disconnectedSince = null;

        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'connected',
          numberId,
          sessionId,
          timestamp: Date.now(),
        });

        await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
          numberId,
          status: 'HEALTHY',
        });
        break;
      }

      case 'FAILED':
      case 'STOPPED': {
        session.connected = false;
        session.isReady = false;
        session.disconnectedSince = session.disconnectedSince || Date.now();

        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: status === 'FAILED' ? 'error' : 'disconnected',
          numberId,
          sessionId,
          reason: status,
          timestamp: Date.now(),
        });

        await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
          numberId,
          status: 'DISCONNECTED',
          reason: status,
        });
        break;
      }

      default:
        logger.debug(`[STATUS] Ignoring transient status ${status} for ${sessionId}`);
    }
  }

  /**
   * Called by the webhook server when a WAHA container reports an
   * incoming WhatsApp message.
   */
  async onIncomingMessage(numberId, payload) {
    const session = this.getSession(numberId);
    if (!session || !payload) return;

    logger.info(`Incoming message for ${session.sessionId} from ${payload.from}`);

    try {
      await rabbitmq.publish(config.rabbitmq.queues.messageReceive, {
        sessionId: session.sessionId,
        numberId,
        from: payload.from,
        body: payload.body,
        timestamp: payload.timestamp,
        hasMedia: payload.hasMedia,
        type: payload.type,
      });
    } catch (error) {
      logger.error('Error publishing incoming message:', error);
    }
  }
}

export default new SessionManager();
