import { config } from '../config/config.js';
import logger from '../utils/logger.js';
import rabbitmq from '../services/rabbitMQService.js';
import dockerManager from './dockerManager.js';
import wahaClient from './wahaClient.js';

class SessionManager {
  constructor() {
    this.sessions = new Map();
    // WAHA message id -> { messageId, numberId }, so a later message.ack
    // webhook (real WhatsApp delivery confirmation/failure) can be matched
    // back to the caller's own messageId. Without this we can only ever
    // report the optimistic "WAHA accepted the HTTP request" result, which
    // is not the same as "WhatsApp actually delivered it".
    this.pendingAcks = new Map();
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
      this.startStatusWatch(numberId);
    } catch (error) {
      logger.error({ err: error }, `[CREATE SESSION] Failed to start WAHA session for ${sessionId}`);
      throw error;
    }

    return session;
  }

  async closeSession(numberId, deleteFiles = false) {
    const session = this.getSession(numberId);
    logger.info(`[CLOSE SESSION] Closing session for numberId ${numberId} (deleteFiles: ${deleteFiles})`);
    this.stopStatusWatch(session);

    if (deleteFiles) {
      await dockerManager.removeContainer(numberId, { removeVolume: true });
    } else {
      await dockerManager.stopContainer(numberId);
    }

    if (session) {
      this.sessions.delete(session.sessionId);
    }
  }

  async sendMessage(numberId, recipient, content, type = 'text', mediaUrl = null, messageId = null) {
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

      // WEBJS returns id as { _serialized, id, ... }; other engines may return
      // a plain string or { key: { id } }. message.ack webhooks carry the
      // full serialized id, so that's the one to key pendingAcks on.
      const waMessageId =
        result?.id?._serialized ||
        (typeof result?.id === 'string' ? result.id : null) ||
        result?.key?.id ||
        null;

      if (!waMessageId) {
        // WAHA answered 2xx but WhatsApp produced no message: nothing was
        // actually sent. Reporting SENT here is what made messages "leave"
        // on the dashboard while never reaching the recipient.
        logger.error(`WAHA returned no message id for ${recipient}, response: ${JSON.stringify(result)}`);
        throw new Error(`WhatsApp did not create the message (no message id returned) for ${recipient}`);
      }

      logger.info(`Message sent successfully to ${recipient} (waId: ${waMessageId})`);

      if (messageId) {
        this.pendingAcks.set(waMessageId, { messageId, numberId });
      }

      return {
        success: true,
        // null (not a sentinel string): whatsapp_message_id has a unique DB
        // constraint on the backend, a fixed placeholder would collide across
        // messages that all lack a real WAHA id.
        messageId: waMessageId,
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

  /**
   * Returns the chatId WhatsApp actually knows for the first variant that has
   * an account, or null if none of them do.
   */
  async resolveRecipient(numberId, variants) {
    const session = this.getSession(numberId);
    if (!session) throw new Error(`Session not found for number ID: ${numberId}`);

    for (const variant of variants) {
      try {
        const { exists, chatId } = await wahaClient.checkNumberExists(session.baseUrl, variant);
        logger.info(`[CHECK NUMBER] ${variant} -> exists=${exists} chatId=${chatId}`);
        if (exists) return chatId || `${variant}@c.us`;
      } catch (error) {
        const apiMessage = error.response?.data?.message || error.message;
        logger.warn(`[CHECK NUMBER] check-exists failed for ${variant}: ${apiMessage}`);
        // Can't verify (endpoint error): rethrow so the message is retried
        // instead of being blindly sent to a possibly wrong chatId.
        const wrapped = new Error(`Could not verify recipient ${variant}: ${apiMessage}`);
        wrapped.temporary = true;
        throw wrapped;
      }
    }
    return null;
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

    // 2. Reap des conteneurs WAHA orphelins (présents sur l'hôte mais sans
    //    session en mémoire : restore échoué, createSession qui a throw avant
    //    d'enregistrer la session, ancien conteneur d'un worker précédent...).
    //    Sans ça ils tournent indéfiniment et consomment la RAM.
    await this.reapOrphanContainers();
  }

  async reapOrphanContainers() {
    let containers;
    try {
      containers = await dockerManager.listManagedContainers();
    } catch (error) {
      logger.error('[REAP] Failed to list managed containers:', error.message);
      return;
    }

    const now = Date.now();
    // Ne pas toucher un conteneur créé il y a moins de 5 min : createSession
    // crée le conteneur AVANT d'insérer la session dans la Map, il y a une
    // courte fenêtre où un conteneur légitime n'est pas encore "tracké".
    const minAgeMs = 5 * 60 * 1000;

    const trackedNumberIds = new Set(
      Array.from(this.sessions.values()).map((s) => s.numberId)
    );

    for (const c of containers) {
      if (trackedNumberIds.has(c.numberId)) continue;

      if (c.created && now - c.created * 1000 < minAgeMs) {
        logger.debug(`[REAP] Container waha-${c.numberId} untracked but < 5 min old, skipping`);
        continue;
      }

      logger.warn(`[REAP] Orphan WAHA container for numberId ${c.numberId} (no active session). Removing container + volume...`);

      try {
        await this.closeSession(c.numberId, true);
      } catch (error) {
        logger.error(`[REAP] Failed to remove orphan container ${c.numberId}:`, error.message);
        continue;
      }

      try {
        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'deleted_orphan',
          numberId: c.numberId,
          timestamp: Date.now(),
        });

        // Indispensable : sans ça le backend garde le numéro "connecté" sur
        // le dashboard client alors que le conteneur n'existe plus.
        await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
          numberId: c.numberId,
          status: 'DISCONNECTED',
          reason: 'Orphan container removed (no active session)',
          workerId: config.worker.id,
        });
      } catch (pubError) {
        logger.error(`[REAP] Failed to publish orphan deletion event for ${c.numberId}:`, pubError.message);
      }
    }
  }

  async restoreSessions() {
    logger.info('[RESTORE] Starting automatic session restoration from Docker...');

    const containers = await dockerManager.listManagedContainers();
    logger.info(`[RESTORE] Found ${containers.length} managed WAHA container(s)`);

    let restored = 0;
    let failed = 0;

    for (const { numberId, phoneNumber, running } of containers) {
      if (!phoneNumber) {
        logger.warn(`[RESTORE] Container for numberId ${numberId} has no phoneNumber label, skipping`);
        continue;
      }

      // Un conteneur arrêté n'est PAS une session morte : après un reboot de
      // l'hôte, un redeploy, un restart du daemon Docker, ou notre propre
      // stopContainer sur FAILED, tous les conteneurs sont `exited` alors que
      // le volume d'auth est intact et la session récupérable. On les rallume.
      // Les sessions réellement mortes seront nettoyées (conteneur + volume,
      // avec notif backend) par cleanInactiveSessions au bout de 10 min, et
      // les conteneurs sans session par reapOrphanContainers.
      try {
        logger.info(`[RESTORE] Restoring session for numberId: ${numberId}, phone: ${phoneNumber} (container ${running ? 'running' : 'stopped, will restart'})...`);
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
   * Polls WAHA while the session is starting / waiting for a scan.
   * - WEBJS takes a while to boot Chromium; if the SCAN_QR_CODE webhook is
   *   missed, the QR would otherwise never be published.
   * - WhatsApp rotates the QR every ~20s but WAHA only fires session.status
   *   on state *changes*, so without this the backend keeps showing the
   *   first (expired) QR and the scan fails until someone regenerates.
   */
  startStatusWatch(numberId, { intervalMs = 5000, maxDurationMs = 10 * 60 * 1000 } = {}) {
    const session = this.getSession(numberId);
    if (!session) return;
    this.stopStatusWatch(session);

    const deadline = Date.now() + maxDurationMs;
    let busy = false;

    session.statusWatch = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const current = this.getSession(numberId);
        if (!current || current !== session || Date.now() > deadline) {
          this.stopStatusWatch(session);
          return;
        }

        const status = await wahaClient.getStatus(session.baseUrl);
        // Re-running onSessionStatus for SCAN_QR_CODE refetches the QR and
        // only republishes it if it changed.
        if (status !== session.lastStatus || status === 'SCAN_QR_CODE') {
          await this.onSessionStatus(numberId, status);
        }

        if (['WORKING', 'FAILED', 'STOPPED'].includes(status)) {
          this.stopStatusWatch(session);
        }
      } catch (error) {
        logger.debug(`[STATUS WATCH] ${session.sessionId}: ${error.message}`);
      } finally {
        busy = false;
      }
    }, intervalMs);
  }

  stopStatusWatch(session) {
    if (session?.statusWatch) {
      clearInterval(session.statusWatch);
      session.statusWatch = null;
    }
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
    if (status !== session.lastStatus) {
      logger.info(`[STATUS] ${sessionId} -> ${status}`);
    }
    session.lastStatus = status;

    switch (status) {
      case 'SCAN_QR_CODE': {
        try {
          const qrCode = await wahaClient.getQrBase64(session.baseUrl);
          if (qrCode === session.qrCode) break; // unchanged, don't spam backend
          session.qrCode = qrCode;
          logger.info(`[QR] New QR published for ${sessionId}`);

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

        // Libère la RAM (Chromium/WEBJS ≈ 400 Mo) tout de suite au lieu
        // d'attendre les 10 min de cleanInactiveSessions. Le volume d'auth
        // est conservé ; le reconnect auto (HealthHandler) redémarrera le
        // conteneur si la session est récupérable, sinon cleanInactiveSessions
        // finira par supprimer conteneur + volume.
        try {
          await dockerManager.stopContainer(numberId);
          logger.info(`[STATUS] Container stopped for ${sessionId} after ${status} (RAM freed, volume kept)`);
        } catch (stopError) {
          logger.error(`[STATUS] Failed to stop container for ${sessionId} after ${status}:`, stopError);
        }

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

  /**
   * Called by the webhook server on message.ack - the real WhatsApp-side
   * delivery confirmation/failure, as opposed to sendMessage()'s return
   * value which only means "WAHA's HTTP API accepted the request".
   */
  async onMessageAck(numberId, payload) {
    const waMessageId = payload?.id;
    if (!waMessageId) return;

    const pending = this.pendingAcks.get(waMessageId);
    if (!pending) return; // not a message we sent, or already resolved

    const isError = payload.ack === -1 || payload.ackName === 'ERROR';
    if (!isError) {
      // Positive ack (SERVER/DEVICE/READ/PLAYED): already reported SENT at
      // send time, nothing more actionable to tell the backend.
      this.pendingAcks.delete(waMessageId);
      return;
    }

    this.pendingAcks.delete(waMessageId);
    logger.warn(`[ACK] Message ${pending.messageId} failed delivery (${payload.ackName || payload.ack}) for number ${numberId}`);

    try {
      await rabbitmq.publish(config.rabbitmq.queues.messageReceive, {
        messageId: pending.messageId,
        status: 'FAILED',
        errorMessage: `WhatsApp delivery failed (${payload.ackName || 'ERROR'})`,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error(`Error publishing ack failure for message ${pending.messageId}:`, error);
    }
  }
}

export default new SessionManager();
