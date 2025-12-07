import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
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
    const sessionId = `session_${numberId}_${phoneNumber}`;

    if (this.sessions.has(sessionId)) {
      logger.warn(`Session ${sessionId} already exists`);
      return this.sessions.get(sessionId);
    }

    logger.info(`Creating new WhatsApp session: ${sessionId}`);

    try {
      const sessionPath = path.join(this.sessionDir, sessionId);

      // Créer le dossier s'il n'existe pas
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();

      logger.info(`Using Baileys version: ${version.join('.')}`);

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
        // ✅ Options pour éviter l'erreur 515
        browser: ['WhatsApp Pool', 'Chrome', '121.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        // ✅ Important pour la stabilité
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        emitOwnEvents: false,
        fireInitQueries: true,
        qrTimeout: 60000,
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

      logger.info(`Session ${sessionId} initialized successfully`);
      return session;

    } catch (error) {
      logger.error('Failed to create session:', {
        sessionId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  async handleConnectionUpdate(sessionId, update) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { connection, lastDisconnect, qr } = update;

    // QR Code généré
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

        logger.info(`QR Code sent to backend for number ${session.numberId}`);
      } catch (error) {
        logger.error('QR conversion error:', error);
      }
    }

    // Connexion fermée
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || 'Unknown error';

      logger.warn(`Connection closed for ${sessionId}. Code: ${statusCode} - ${errorMessage}`);

      // Logged out définitivement
      if (statusCode === DisconnectReason.loggedOut) {
        logger.error(`User logged out for ${sessionId}`);

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

      // Erreur 515 - Stream Error (besoin de nettoyer)
      if (statusCode === 515 || errorMessage.includes('Stream Errored')) {
        logger.error(`Error 515 detected for ${sessionId}. Cleaning session...`);

        // Supprimer la session
        this.sessions.delete(sessionId);

        // Nettoyer les fichiers de session
        const sessionPath = path.join(this.sessionDir, sessionId);
        try {
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            logger.info(`Session files deleted: ${sessionPath}`);
          }
        } catch (err) {
          logger.error(`Error deleting session folder: ${err.message}`);
        }

        // Notifier le backend
        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'error',
          numberId: session.numberId,
          sessionId,
          error: 'Connection failed (Error 515). Session cleaned. Please request a new QR code after 2 minutes.',
          errorCode: 515,
          timestamp: Date.now(),
        });

        return;
      }

      // Conflit de session
      if (statusCode === DisconnectReason.conflict) {
        logger.warn(`Session conflict detected for ${sessionId}. Resetting...`);

        const sessionPath = path.join(this.sessionDir, sessionId);
        try {
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
        } catch (err) {
          logger.error(`Error deleting conflicted session: ${err.message}`);
        }

        this.sessions.delete(sessionId);

        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'session_conflict',
          numberId: session.numberId,
          sessionId,
          timestamp: Date.now(),
        });

        // Attendre un peu avant de recréer
        await new Promise(r => setTimeout(r, 2000));
        return this.createSession(session.numberId, session.phoneNumber);
      }

      // Autres erreurs - Reconnexion automatique
      logger.info(`Reconnecting ${sessionId} in 2 seconds...`);
      await new Promise(r => setTimeout(r, 2000));

      this.sessions.delete(sessionId);
      return this.createSession(session.numberId, session.phoneNumber);
    }

    // Connexion ouverte avec succès
    if (connection === 'open') {
      logger.info(`✅ Session ${sessionId} connected successfully!`);

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
      // Ignore "Intentional Logout" - c'est normal
      if (error.message !== 'Intentional Logout') {
        logger.error(`Error closing session ${sessionId}:`, error);
      }
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

  resetQrRetries(numberId) {
    this.qrRetryAttempts.delete(numberId);
    logger.info(`QR retry counter reset for number ${numberId}`);
  }
}

export default new SessionManager();