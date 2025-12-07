import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';
import rabbitmq from '../services/rabbitMQService.js';

// Note: crypto is globally available in Node.js 22+

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.sessionDir = config.sessions.dir;
    this.qrRetryAttempts = new Map(); // Track QR retry attempts per numberId
    this.maxQrRetries = 3; // Maximum number of QR regeneration attempts

    // Create session directory if it doesn't exist
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  async createSession(numberId, phoneNumber) {
    const sessionId = `session_${numberId}_${phoneNumber}`;

    if (this.sessions.has(sessionId)) {
      logger.warn(`Session ${sessionId} already exists`);
      return this.sessions.get(sessionId);
    }

    logger.info(`Creating new WhatsApp session: ${sessionId}`);

    const sessionPath = path.join(this.sessionDir, sessionId);

    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      generateHighQualityLinkPreview: true,
      getMessage: async () => undefined,
    });

    const session = {
      sock,
      sessionId,
      numberId,
      phoneNumber,
      connected: false,
      qrCode: null,
    };

    this.sessions.set(sessionId, session);

    // Handle connection events
    sock.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(sessionId, update);
    });

    // Handle credentials update
    sock.ev.on('creds.update', saveCreds);

    // Handle messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'notify') {
        for (const msg of messages) {
          await this.handleIncomingMessage(sessionId, msg);
        }
      }
    });

    return session;
  }

  async handleConnectionUpdate(sessionId, update) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { connection, lastDisconnect, qr } = update;

    // -----------------------------------------------------
    // 🔹 1. Gestion du QR CODE
    // -----------------------------------------------------
    if (qr) {
      logger.info(`QR Code generated for ${sessionId}`);
      qrcode.generate(qr, { small: true });

      session.qrCode = qr;

      try {
        const QRCode = await import('qrcode');
        const qrCodeBase64 = await QRCode.default.toDataURL(qr);

        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'qr_generated',
          numberId: session.numberId,
          sessionId,
          qrCode: qrCodeBase64,
          timestamp: Date.now(),
        });
      } catch (error) {
        logger.error('QR conversion error:', error);
        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'qr_generated',
          numberId: session.numberId,
          sessionId,
          qrCode: qr,
          timestamp: Date.now(),
        });
      }
    }

    // -----------------------------------------------------
    // 🔹 2. Connection fermée
    // -----------------------------------------------------
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || 'Unknown error';

      logger.warn(
        `Connection closed for ${sessionId}. Code: ${statusCode} - ${errorMessage}`
      );

      // ----------------------------
      // ❌ Déconnecté définitivement
      // ----------------------------
      if (statusCode === DisconnectReason.loggedOut) {
        logger.error(`User logged out for ${sessionId}.`);

        this.sessions.delete(sessionId);
        this.qrRetryAttempts.delete(session.numberId);

        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'disconnected',
          reason: 'logged_out',
          sessionId,
          numberId: session.numberId,
          timestamp: Date.now(),
        });

        await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
          numberId: session.numberId,
          status: 'BANNED',
          reason: 'Logged out from WhatsApp',
        });

        return;
      }

      // ----------------------------
      // ⏳ QR EXPIRED / 3 essais max
      // ----------------------------
      if (errorMessage.includes('QR refs attempts ended')) {
        const attempts = this.qrRetryAttempts.get(session.numberId) || 0;

        if (attempts < this.maxQrRetries) {
          this.qrRetryAttempts.set(session.numberId, attempts + 1);

          logger.info(
            `Regenerating QR for ${sessionId} (${attempts + 1}/${this.maxQrRetries})`
          );

          this.sessions.delete(sessionId);

          await this.createSession(session.numberId, session.phoneNumber);

          await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
            action: 'qr_regenerating',
            attempt: attempts + 1,
            maxAttempts: this.maxQrRetries,
            numberId: session.numberId,
            sessionId,
            timestamp: Date.now(),
          });

          return;
        }

        logger.error(`Max QR retries reached for ${sessionId}.`);

        this.sessions.delete(sessionId);
        this.qrRetryAttempts.delete(session.numberId);

        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'error',
          numberId: session.numberId,
          sessionId,
          error: 'Max QR attempts reached',
          timestamp: Date.now(),
        });

        return;
      }

      // ----------------------------
      // 🔄 Crash normal → Reconnexion
      // ----------------------------
      logger.info(`Reconnect attempt for ${sessionId} in 2 seconds...`);
      await new Promise((r) => setTimeout(r, 2000));

      this.sessions.delete(sessionId);
      await this.createSession(session.numberId, session.phoneNumber);

      return;
    }

    // -----------------------------------------------------
    // 🔹 3. Connection OK
    // -----------------------------------------------------
    if (connection === 'open') {
      logger.info(`Session ${sessionId} connected successfully.`);

      session.connected = true;
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
    }
  }


  async handleIncomingMessage(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      const messageData = {
        sessionId,
        numberId: session.numberId,
        messageId: message.key.id,
        from: message.key.remoteJid,
        timestamp: message.messageTimestamp,
        message: message.message,
      };

      logger.info(`Incoming message for ${sessionId} from ${message.key.remoteJid}`);

      // Forward to backend
      await rabbitmq.publish(config.rabbitmq.queues.messageReceive, messageData);
    } catch (error) {
      logger.error('Error handling incoming message:', error);
    }
  }

  async sendMessage(numberId, recipient, content, type = 'text', mediaUrl = null) {
    const session = Array.from(this.sessions.values()).find(
      (s) => s.numberId === numberId
    );

    if (!session) {
      throw new Error(`Session not found for number ID: ${numberId}`);
    }

    if (!session.connected) {
      throw new Error(`Session not connected for number ID: ${numberId}`);
    }

    logger.info(`Sending ${type} message to ${recipient}`);

    try {
      let result;

      switch (type.toLowerCase()) {
        case 'text':
          result = await session.sock.sendMessage(recipient, { text: content });
          break;

        case 'image':
          result = await session.sock.sendMessage(recipient, {
            image: { url: mediaUrl },
            caption: content,
          });
          break;

        case 'video':
          result = await session.sock.sendMessage(recipient, {
            video: { url: mediaUrl },
            caption: content,
          });
          break;

        case 'document':
          result = await session.sock.sendMessage(recipient, {
            document: { url: mediaUrl },
            mimetype: 'application/pdf',
            fileName: content,
          });
          break;

        case 'audio':
          result = await session.sock.sendMessage(recipient, {
            audio: { url: mediaUrl },
            mimetype: 'audio/mp4',
          });
          break;

        default:
          throw new Error(`Unsupported message type: ${type}`);
      }

      logger.info(`Message sent successfully to ${recipient}`);

      return {
        success: true,
        messageId: result.key.id,
      };
    } catch (error) {
      logger.error(`Error sending message to ${recipient}:`, error);
      throw error;
    }
  }

  getSession(numberId) {
    return Array.from(this.sessions.values()).find(
      (s) => s.numberId === numberId
    );
  }

  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    logger.info(`Closing session: ${sessionId}`);

    try {
      await session.sock.logout();
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
    }));
  }

  // Réinitialiser le compteur de tentatives QR pour un numéro spécifique
  resetQrRetries(numberId) {
    this.qrRetryAttempts.delete(numberId);
    logger.info(`QR retry counter reset for number ${numberId}`);
  }
}

export default new SessionManager();