import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';
import rabbitmq from '../services/rabbitMQService.js';

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

  async createSession(numberId, phoneNumber) {
    // Clean phone number to remove invalid characters for clientId
    const cleanPhoneNumber = phoneNumber.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessionId = `session_${numberId}_${cleanPhoneNumber}`;

    logger.info(`[CREATE SESSION] Request for numberId: ${numberId}, phone: ${phoneNumber}`);
    logger.info(`[CREATE SESSION] SessionId will be: ${sessionId}`);
    logger.info(`[CREATE SESSION] Current active sessions: ${this.sessions.size}`);

    if (this.sessions.has(sessionId)) {
      logger.warn(`[CREATE SESSION] Session ${sessionId} already exists, returning existing session`);
      return this.sessions.get(sessionId);
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
      '--disable-extensions'
    ];

    // Create WhatsApp client with LocalAuth
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: sessionPath
      }),
      // Using specific web version as workaround for 'markedUnread' error
      webVersion: '2.3000.1033110843-alpha',
      webVersionCache: {
        type: "remote",
        remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1033110843-alpha.html",
      },
      puppeteer: {
        headless: true,
        args: puppeteerArgs,
      }
    });

    const session = {
      client,
      sessionId,
      numberId,
      phoneNumber,
      connected: false,
      qrCode: null,
      isReady: false
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

      if (reason === 'LOGOUT') {
        logger.info(`Session ${sessionId} logged out, cleaning up...`);
        this.sessions.delete(sessionId);

        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'disconnected',
          numberId: session.numberId,
          sessionId,
          reason: 'LOGOUT',
          timestamp: Date.now(),
        });
      } else {
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
      logger.error(`Failed to initialize client for ${sessionId}:`);
      logger.error(`Error name: ${error.name}`);
      logger.error(`Error message: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
      this.sessions.delete(sessionId);
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

    const formattedRecipient = recipient.includes('@')
      ? recipient
      : `${recipient}@c.us`;

    logger.info(`Sending ${type} message to ${formattedRecipient} (original: ${recipient})`);

    try {
      // 1. Check real connection state
      const state = await session.client.getState();
      logger.info(`[SEND] Client state for ${numberId}: ${state}`);

      if (state !== 'CONNECTED') {
        throw new Error(`Client state is ${state} (not CONNECTED) for number ID: ${numberId}`);
      }

      // 2. Validate Number via WhatsApp API (Crucial!)
      const numberDetails = await session.client.getNumberId(formattedRecipient);

      if (!numberDetails) {
        logger.error(`[SEND] Number not found on WhatsApp: ${formattedRecipient}`);
        throw new Error(`Number ${recipient} is not registered on WhatsApp`);
      }

      const exactId = numberDetails._serialized; // Use the exact ID returned by WhatsApp
      logger.info(`[SEND] Number validated. Exact ID: ${exactId}`);

      let result;

      // 3. Ensure Chat exists (helps with syncing)
      // Use exactId which is guaranteed to be correct
      // 3. Ensure Chat exists and is loaded
      try {
        const chat = await session.client.getChatById(exactId);
        logger.debug(`[SEND] Chat found: ${chat.name || 'Unknown'} (${chat.id._serialized})`);

        // REFRESH: Fetch last message to force-load chat memory and avoid 'markedUnread' on undefined
        await chat.fetchMessages({ limit: 1 }).catch(e => logger.debug(`Fetch error (ignorable): ${e.message}`));

        // Small delay to ensure sync
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (e) {
        logger.warn(`[SEND] Could not get/load chat object, attempting direct send anyway: ${e.message}`);
      }

      switch (type.toLowerCase()) {
        case 'text':
          // EXTREME FIX: Monkey-patch sendSeen on the Chat object to avoid 'markedUnread' crash
          // The crash happens because WWebJS tries to mark the chat as read/seen, but the internal property is missing.
          try {
            const chatObj = await session.client.getChatById(exactId);
            // Disable sendSeen for this specific send operation
            chatObj.sendSeen = async () => true;

            // Now send using the chat object which has the safe sendSeen
            result = await chatObj.sendMessage(content);
          } catch (patchError) {
            logger.warn(`[SEND] Patching/sending failed, fallback to direct client send: ${patchError.message}`);
            result = await session.client.sendMessage(exactId, content);
          }
          break;

        case 'image':
          if (!mediaUrl) {
            throw new Error('Media URL is required for image messages');
          }
          const imageMedia = await MessageMedia.fromUrl(mediaUrl);
          result = await session.client.sendMessage(exactId, imageMedia, {
            caption: content
          });
          break;

        case 'video':
          if (!mediaUrl) {
            throw new Error('Media URL is required for video messages');
          }
          const videoMedia = await MessageMedia.fromUrl(mediaUrl);
          result = await session.client.sendMessage(exactId, videoMedia, {
            caption: content
          });
          break;

        case 'document':
          if (!mediaUrl) {
            throw new Error('Media URL is required for document messages');
          }
          const docMedia = await MessageMedia.fromUrl(mediaUrl);
          result = await session.client.sendMessage(exactId, docMedia, {
            caption: content
          });
          break;

        case 'audio':
          if (!mediaUrl) {
            throw new Error('Media URL is required for audio messages');
          }
          const audioMedia = await MessageMedia.fromUrl(mediaUrl);
          result = await session.client.sendMessage(exactId, audioMedia);
          break;

        default:
          throw new Error(`Unsupported message type: ${type}`);
      }

      logger.info(`Message sent successfully to ${recipient}`);

      return {
        success: true,
        messageId: result.id.id,
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

  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    logger.info(`Closing session: ${sessionId}`);

    try {
      await session.client.destroy();
    } catch (error) {
      logger.error(`Error closing session ${sessionId}:`, error);
    }

    this.sessions.delete(sessionId);
  }

  async closeAllSessions() {
    logger.info('Closing all sessions...');

    for (const [sessionId] of this.sessions) {
      await this.closeSession(sessionId);
    }
  }

  getActiveSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      numberId: s.numberId,
      phoneNumber: s.phoneNumber,
      connected: s.connected,
      isReady: s.isReady
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