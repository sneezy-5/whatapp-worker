import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';
import rabbitmq from '../services/rabbitMQService.js';
import { withTimeout } from '../utils/helpers.js';

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.sessionDir = config.sessions.dir;
    this.qrRetryAttempts = new Map();
    this.maxQrRetries = 3;

    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  async createSession(numberId, phoneNumber, { force = false } = {}) {
    // Clean phone number to remove invalid characters for clientId
    const cleanPhoneNumber = phoneNumber.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessionId = `session_${numberId}_${cleanPhoneNumber}`;

    logger.info(`[CREATE SESSION] Request for numberId: ${numberId}, phone: ${phoneNumber}`);
    logger.info(`[CREATE SESSION] SessionId will be: ${sessionId}`);
    logger.info(`[CREATE SESSION] Current active sessions: ${this.sessions.size}`);

    const existingSession = this.sessions.get(sessionId);
    const lastReconnectAttempt = existingSession ? (existingSession.lastReconnectAttempt || 0) : 0;

    if (this.sessions.has(sessionId)) {
      // `force` is used when the caller already confirmed (e.g. a getState() timeout)
      // that this session is stuck despite connected/isReady still reading true —
      // those flags only flip on WWebJS events that a frozen Chromium tab never fires,
      // so the normal fast-path below would otherwise wrongly skip recreation forever.
      if (existingSession.connected && existingSession.isReady && !force) {
        logger.warn(`[CREATE SESSION] Session ${sessionId} already exists and is connected, returning existing session`);
        return existingSession;
      }
      if (existingSession.sendInProgress > 0) {
        logger.warn(`[CREATE SESSION] Session ${sessionId} has a send in progress, skipping recreation this cycle`);
        return existingSession;
      }
      logger.warn(`[CREATE SESSION] Session ${sessionId} exists in memory but is not connected/ready${force ? ' (forced)' : ''}. Closing and recreating...`);
      await this.closeSession(numberId, false);
    }

    logger.info(`[CREATE SESSION] Creating new WhatsApp session: ${sessionId} for ${phoneNumber}`);

    const sessionPath = path.join(this.sessionDir, sessionId);

    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    logger.info(`Session path: ${sessionPath}`);

    // Simplified arguments for standard Puppeteer (no Docker issues if running bare metal)
    const puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-gpu',
      '--no-zygote',
      '--no-first-run'
    ];

    // Create WhatsApp client with LocalAuth
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: sessionPath
      }),
      puppeteer: {
        headless: true,
        args: puppeteerArgs,
        // protocolTimeout was previously 0 (disabled). That means a frozen/crashed
        // Chromium tab makes every CDP call (getState, sendMessage, destroy...) hang
        // forever with no error — the classic "message never sends, only a full
        // service restart fixes it" symptom. Give it a generous but finite ceiling
        // per low-level command instead.
        protocolTimeout: 120000,
      }
    });

    const session = {
      client,
      sessionId,
      numberId,
      phoneNumber,
      connected: false,
      qrCode: null,
      isReady: false,
      disconnectedSince: Date.now(),
      lastReconnectAttempt: lastReconnectAttempt || Date.now(),
      sendInProgress: 0
    };

    this.sessions.set(sessionId, session);

    // QR Code Event
    client.on('qr', async (qr) => {
      logger.info(`QR Code generated for ${sessionId}`);
      qrcode.generate(qr, { small: true });

      session.qrCode = qr;

      try {
        const qrBase64 = await QRCode.toDataURL(qr);

        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'qr_generated',
          numberId: session.numberId,
          sessionId,
          qrCode: qrBase64,
          timestamp: Date.now(),
        });

        logger.info(`QR code sent to backend for session ${sessionId}`);
      } catch (error) {
        logger.error(`Error generating QR code for ${sessionId}:`, error);
      }
    });

    // Ready Event
    client.on('ready', async () => {
      logger.info(`[READY] Session ${sessionId} is ready and connected`);
      logger.info(`[READY] NumberId: ${session.numberId}, Phone: ${session.phoneNumber}`);
      logger.info(`[READY] Total active sessions: ${this.sessions.size}`);

      session.connected = true;
      session.isReady = true;
      session.qrCode = null;
      session.disconnectedSince = null;
      this.qrRetryAttempts.delete(session.numberId);

      await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
        action: 'connected',
        numberId: session.numberId,
        sessionId,
        timestamp: Date.now(),
      });

      await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
        numberId: session.numberId,
        status: 'HEALTHY',
      });

      logger.info(`[READY] Session ${sessionId} fully initialized and reported to backend`);
    });

    // Authenticated Event
    client.on('authenticated', () => {
      logger.info(`Session ${sessionId} authenticated`);
    });

    // Disconnected Event
    client.on('disconnected', async (reason) => {
      logger.warn(`Session ${sessionId} disconnected:`, reason);

      session.connected = false;
      session.isReady = false;
      session.disconnectedSince = session.disconnectedSince || Date.now();

      // Notify backend of disconnection on the workerEvents queue
      await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
        action: 'disconnected',
        numberId: session.numberId,
        sessionId,
        reason: reason || 'UNKNOWN',
        timestamp: Date.now(),
      });

      if (reason === 'LOGOUT') {
        logger.info(`Session ${sessionId} logged out, cleaning up memory...`);
        this.sessions.delete(sessionId);
      } else {
        // Also report as health issue if it's not a voluntary logout
        await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
          numberId: session.numberId,
          status: 'DISCONNECTED',
          reason: reason,
        });
      }
    });

    // Auth Failure Event
    client.on('auth_failure', async (msg) => {
      logger.error(`Authentication failure for ${sessionId}:`, msg);

      await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
        action: 'error',
        numberId: session.numberId,
        sessionId,
        error: 'Authentication failed',
        timestamp: Date.now(),
      });
    });

    // Loading Screen Event
    client.on('loading_screen', (percent, message) => {
      logger.debug(`Loading screen for ${sessionId}: ${percent}% - ${message}`);
    });

    // Change State Event
    client.on('change_state', state => {
      logger.debug(`State changed for ${sessionId}:`, state);
    });

    // Message Event
    client.on('message', async (message) => {
      try {
        await this.handleIncomingMessage(sessionId, message);
      } catch (error) {
        logger.error(`Error handling incoming message for ${sessionId}:`, error);
      }
    });

    // Initialize the client
    try {
      logger.info(`Initializing client for ${sessionId}...`);
      await client.initialize();
      logger.info(`Client initialized for ${sessionId}`);
    } catch (error) {
      logger.error({ err: error }, `Failed to initialize client for ${sessionId}`);
      console.error(`\n❌ [SESSION ${sessionId}] Initialization Error: ${error.message}\n`);

      this.sessions.delete(sessionId);

      // CRITICAL: Clear session folder on disk if initialization fails
      logger.warn(`[CLEANUP] Initialization failed for ${sessionId}, removing folder...`);
      this.cleanupSessionStorage(numberId);

      throw error;
    }

    return session;
  }

  async handleIncomingMessage(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    logger.info(`Incoming message for ${sessionId} from ${message.from}`);

    try {
      await rabbitmq.publish(config.rabbitmq.queues.messageReceive, {
        sessionId,
        numberId: session.numberId,
        from: message.from,
        body: message.body,
        timestamp: message.timestamp,
        hasMedia: message.hasMedia,
        type: message.type,
      });
    } catch (error) {
      logger.error(`Error publishing incoming message:`, error);
    }
  }

  async sendMessage(numberId, recipient, content, type = 'text', mediaUrl = null) {
    const session = Array.from(this.sessions.values()).find(
      (s) => s.numberId === numberId
    );

    if (!session) {
      throw new Error(`Session not found for number ID: ${numberId}`);
    }

    if (!session.connected || !session.isReady) {
      throw new Error(`Session not ready for number ID: ${numberId}. Status: connected=${session.connected}, ready=${session.isReady}`);
    }

    // Mark this session as busy so a concurrent auto-reconnect (triggered by a
    // 'disconnected' event or health check firing mid-send) doesn't destroy the
    // client out from under this in-flight send.
    session.sendInProgress = (session.sendInProgress || 0) + 1;

    const formattedRecipient = recipient.includes('@')
      ? recipient
      : `${recipient}@c.us`;

    logger.info(`Sending ${type} message to ${formattedRecipient} (original: ${recipient})`);

    try {
      // 1. Check real connection state
      const state = await withTimeout(
        session.client.getState(),
        config.whatsapp.messageTimeout,
        `getState for ${numberId}`
      );
      logger.info(`[SEND] Client state for ${numberId}: ${state}`);

      if (state !== 'CONNECTED') {
        throw new Error(`Client state is ${state} (not CONNECTED) for number ID: ${numberId}`);
      }

      // 2. Validate Number via WhatsApp API (Crucial!)
      const numberDetails = await withTimeout(
        session.client.getNumberId(formattedRecipient),
        config.whatsapp.messageTimeout,
        `getNumberId for ${formattedRecipient}`
      );

      if (!numberDetails) {
        logger.error(`[SEND] Number not found on WhatsApp: ${formattedRecipient}`);
        const regError = new Error(`Number ${recipient} is not registered on WhatsApp`);
        regError.code = 'INVALID_RECIPIENT';
        throw regError;
      }

      const exactId = numberDetails._serialized; // Use the exact ID returned by WhatsApp
      logger.info(`[SEND] Number validated. Exact ID: ${exactId}`);

      let result;

      // 3. Ensure Chat exists and is loaded, then patch sendSeen on it.
      // EXTREME FIX: WWebJS tries to mark the chat as read/seen before sending, and throws
      // 'markedUnread' when the internal property is missing on chats that were never opened.
      // This affects every message type, not just text, so the chat object (and its patch)
      // is shared by all branches below via sendViaChatOrClient.
      let chatObj = null;
      try {
        chatObj = await withTimeout(
          session.client.getChatById(exactId),
          config.whatsapp.messageTimeout,
          `getChatById for ${exactId}`
        );
        logger.debug(`[SEND] Chat found: ${chatObj.name || 'Unknown'} (${chatObj.id._serialized})`);

        // REFRESH: Fetch last message to force-load chat memory and avoid 'markedUnread' on undefined
        await withTimeout(
          chatObj.fetchMessages({ limit: 1 }),
          config.whatsapp.messageTimeout,
          `fetchMessages for ${exactId}`
        ).catch(e => logger.debug(`Fetch error (ignorable): ${e.message}`));

        // Small delay to ensure sync
        await new Promise(resolve => setTimeout(resolve, 500));

        chatObj.sendSeen = async () => true;
      } catch (e) {
        logger.warn(`[SEND] Could not get/load chat object, attempting direct send anyway: ${e.message}`);
        chatObj = null;
      }

      const sendViaChatOrClient = async (media, options) => {
        try {
          if (!chatObj) throw new Error('No chat object available');
          return await withTimeout(
            chatObj.sendMessage(media, options),
            config.whatsapp.messageTimeout,
            `chat.sendMessage for ${exactId}`
          );
        } catch (patchError) {
          logger.warn(`[SEND] Sending via chat object failed, fallback to direct client send: ${patchError.message}`);
          return await withTimeout(
            session.client.sendMessage(exactId, media, options),
            config.whatsapp.messageTimeout,
            `client.sendMessage for ${exactId}`
          );
        }
      };

      switch (type.toLowerCase()) {
        case 'text':
          result = await sendViaChatOrClient(content);
          break;

        case 'image':
          if (!mediaUrl) {
            throw new Error('Media URL is required for image messages');
          }
          const imageMedia = await MessageMedia.fromUrl(mediaUrl);
          result = await sendViaChatOrClient(imageMedia, { caption: content });
          break;

        case 'video':
          if (!mediaUrl) {
            throw new Error('Media URL is required for video messages');
          }
          const videoMedia = await MessageMedia.fromUrl(mediaUrl);
          result = await sendViaChatOrClient(videoMedia, { caption: content });
          break;

        case 'document':
          if (!mediaUrl) {
            throw new Error('Media URL is required for document messages');
          }
          const docMedia = await MessageMedia.fromUrl(mediaUrl);
          result = await sendViaChatOrClient(docMedia, { caption: content });
          break;

        case 'audio':
          if (!mediaUrl) {
            throw new Error('Media URL is required for audio messages');
          }
          const audioMedia = await MessageMedia.fromUrl(mediaUrl);
          result = await sendViaChatOrClient(audioMedia);
          break;

        default:
          throw new Error(`Unsupported message type: ${type}`);
      }

      logger.info(`Message sent successfully to ${recipient}`);

      return {
        success: true,
        messageId: result?.id?.id || 'UNKNOWN',
      };
    } catch (error) {
      const errorMessage = error.message || '';
      const errorStack = error.stack || '';
      const errorString = String(error);
      const isMarkedUnreadError = /markedUnread/i.test(errorMessage) ||
        /markedUnread/i.test(errorStack) ||
        /markedUnread/i.test(errorString);

      if (errorMessage.includes('No LID for user')) {
        const betterError = new Error(
          `Cannot send message to ${recipient}: Number not registered on WhatsApp or session not fully ready. ` +
          `Please ensure the session is connected and the recipient number is valid.`
        );
        betterError.code = 'INVALID_RECIPIENT';
        logger.error(`LID error for ${recipient}:`, betterError.message);
        throw betterError;
      }

      // Removed 'markedUnread' bypass. If this error occurs, it means Puppeteer failed to confirm sending.
      // We should let it throw so the worker knows it failed.

      logger.error(`Error sending message to ${recipient}:`, error);
      throw error;
    } finally {
      session.sendInProgress = Math.max(0, (session.sendInProgress || 1) - 1);
    }
  }

  getSession(numberId) {
    logger.debug(`Looking for session with numberId: ${numberId}`);
    logger.debug(`Available sessions: ${Array.from(this.sessions.keys()).join(', ')}`);

    const session = Array.from(this.sessions.values()).find(
      (s) => s.numberId === numberId
    );

    if (session) {
      logger.debug(`Found session: ${session.sessionId} for numberId: ${numberId}`);
    } else {
      logger.warn(`No session found for numberId: ${numberId}`);
      logger.debug(`Available numberIds: ${Array.from(this.sessions.values()).map(s => s.numberId).join(', ')}`);
    }

    return session;
  }

  async closeSession(numberId, deleteFiles = false) {
    const session = this.getSession(numberId);
    if (!session) {
      // If we want to delete files even if session isn't active in memory
      if (deleteFiles) {
        // We need to reconstruct the sessionId to find the folder
        // This is a bit tricky if we don't have the phoneNumber here
        // But usually we call this when we have a session or we can find the folder by pattern
        logger.warn(`[CLOSE SESSION] No active session for numberId ${numberId}, but deleteFiles requested. Searching disk...`);
        this.cleanupSessionStorage(numberId);
      }
      return;
    }

    const { sessionId } = session;
    logger.info(`[CLOSE SESSION] Closing session: ${sessionId} (deleteFiles: ${deleteFiles})`);

    try {
      // Remove all listeners to prevent reconnection attempts during destruction
      if (session.client) {
        // WWebJS doesn't have a direct removeAllListeners on the internal emitter easily,
        // but destroy() usually handles it. Still, we stop it first.
        // destroy() talks to the same Chromium tab as every other client call, so a frozen
        // tab makes it hang forever too — timeout it and force-kill the browser process
        // directly so a stuck session doesn't permanently block reconnection.
        await withTimeout(session.client.destroy(), 15000, `client.destroy for ${sessionId}`);
      }
    } catch (error) {
      logger.error(`[CLOSE SESSION] Error destroying client for ${sessionId}, force-killing browser process:`, error);
      try {
        const browser = session.client?.pupBrowser;
        const proc = browser?.process?.();
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch (killError) {
        logger.error(`[CLOSE SESSION] Failed to force-kill browser process for ${sessionId}:`, killError);
      }
    }

    this.sessions.delete(sessionId);

    if (deleteFiles) {
      this.cleanupSessionStorage(numberId);
    }
  }

  /**
   * Physically removes session data from disk
   */
  cleanupSessionStorage(numberId) {
    try {
      const sessionDirs = fs.readdirSync(this.sessionDir);
      const prefix = `session_${numberId}_`;

      const dirsToDelete = sessionDirs.filter(d => d.startsWith(prefix));

      for (const dirName of dirsToDelete) {
        const fullPath = path.join(this.sessionDir, dirName);
        logger.info(`[CLEANUP] Deleting session directory: ${fullPath}`);
        fs.rmSync(fullPath, { recursive: true, force: true });
        logger.info(`[CLEANUP] ✅ Deleted: ${dirName}`);
      }
    } catch (error) {
      logger.error(`[CLEANUP] Error during disk cleanup for numberId ${numberId}:`, error);
    }
  }

  async closeAllSessions() {
    logger.info('Closing all sessions...');

    for (const session of this.sessions.values()) {
      await this.closeSession(session.numberId);
    }
  }

  async cleanInactiveSessions() {
    const oneMinuteMs = 1 * 60 * 1000;
    const now = Date.now();

    for (const session of this.sessions.values()) {
      if (!session.connected && session.disconnectedSince && !(session.sendInProgress > 0)) {
        const inactiveTime = now - session.disconnectedSince;
        if (inactiveTime > oneMinuteMs) {
          logger.warn(`[CLEANUP] Session ${session.sessionId} has been disconnected/unconnected for more than 1 minute. Deleting...`);
          
          const numberId = session.numberId;
          const sessionId = session.sessionId;

          // Completely close the session and delete files
          await this.closeSession(numberId, true);
          
          // Notify the backend that the session has been deleted due to inactivity
          try {
            await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
              action: 'deleted_inactivity',
              numberId: numberId,
              sessionId: sessionId,
              timestamp: Date.now(),
            });
            
            await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
              numberId: numberId,
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

  getActiveSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      numberId: s.numberId,
      phoneNumber: s.phoneNumber,
      connected: s.connected,
      isReady: s.isReady,
      disconnectedSince: s.disconnectedSince
    }));
  }

  resetQrRetries(numberId) {
    this.qrRetryAttempts.delete(numberId);
    logger.info(`QR retry counter reset for number ${numberId}`);
  }

  async restoreSessions() {
    logger.info('[RESTORE] Starting automatic session restoration...');

    try {
      const sessionDirs = fs.readdirSync(this.sessionDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      logger.info(`[RESTORE] Found ${sessionDirs.length} session(s) on disk`);
      logger.info(`[RESTORE] Session directories: ${sessionDirs.join(', ')}`);

      if (sessionDirs.length === 0) {
        logger.info('[RESTORE] No sessions to restore');
        return;
      }

      const sessionsToRestore = [];

      for (const dirName of sessionDirs) {
        const match = dirName.match(/^session_(\d+)_(.+)$/);

        if (match) {
          const numberId = parseInt(match[1], 10);
          const phoneNumber = match[2];

          sessionsToRestore.push({ numberId, phoneNumber, dirName });
          logger.info(`[RESTORE] Will restore: numberId=${numberId}, phone=${phoneNumber}`);
        } else {
          logger.warn(`[RESTORE] Skipping invalid session directory: ${dirName}`);
        }
      }

      logger.info(`[RESTORE] Total sessions to restore: ${sessionsToRestore.length}`);

      let restored = 0;
      let failed = 0;

      for (const { numberId, phoneNumber, dirName } of sessionsToRestore) {
        try {
          logger.info(`[RESTORE] Restoring session for numberId: ${numberId}, phone: ${phoneNumber}...`);
          await this.createSession(numberId, phoneNumber);
          restored++;
          logger.info(`[RESTORE] ✅ Successfully restored session ${dirName}`);

          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          logger.error(`[RESTORE] ❌ Failed to restore session for numberId ${numberId}:`, error.message);
          logger.error(`[RESTORE] Error details:`, error);
          failed++;
        }
      }

      logger.info(`[RESTORE] ========================================`);
      logger.info(`[RESTORE] Restoration complete: ${restored} restored, ${failed} failed`);
      logger.info(`[RESTORE] ========================================`);
    } catch (error) {
      logger.error('[RESTORE] Error during session restoration:', error);
    }
  }
}

export default new SessionManager();