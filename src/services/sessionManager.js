import pkg from '@whiskeysockets/baileys';
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = pkg;
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/config.js';
import logger from '../utils/logger.js';
import rabbitmq from '../services/rabbitMQService.js';

// Make crypto globally available for Baileys
global.crypto = crypto;

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

    if (qr) {
      logger.info(`QR Code generated for ${sessionId}`);
      qrcode.generate(qr, { small: true });

      session.qrCode = qr;

      try {
        // Convertir le QR en base64
        const QRCode = await import('qrcode');
        const qrCodeBase64 = await QRCode.default.toDataURL(qr);

        logger.info(`QR Code converted to base64 for ${sessionId}`);

        // ✅ CORRIGÉ : Envoyer sur worker.events au lieu de session.update
        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'qr_generated',
          numberId: session.numberId,
          sessionId,
          qrCode: qrCodeBase64,  // Format: data:image/png;base64,...
          timestamp: Date.now(),
        });

        logger.info(`QR Code sent to backend for number ${session.numberId}`);
      } catch (error) {
        logger.error(`Error converting/sending QR code:`, error);

        // Fallback: envoyer le QR brut si la conversion échoue
        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'qr_generated',
          numberId: session.numberId,
          sessionId,
          qrCode: qr,
          timestamp: Date.now(),
        });
      }
    }

    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;

      const errorMessage = lastDisconnect?.error?.message || 'Unknown error';

      logger.warn(`Connection closed for ${sessionId}. Reconnect: ${shouldReconnect}. Reason: ${errorMessage}`);

      if (shouldReconnect) {
        // Vérifier si c'est une erreur de QR expiré
        if (errorMessage.includes('QR refs attempts ended')) {
          const currentAttempts = this.qrRetryAttempts.get(session.numberId) || 0;

          logger.info(`QR code expired for ${sessionId}. Attempt ${currentAttempts + 1}/${this.maxQrRetries}`);

          if (currentAttempts < this.maxQrRetries) {
            // ✅ RÉGÉNÉRER LE QR CODE
            this.qrRetryAttempts.set(session.numberId, currentAttempts + 1);

            logger.info(`Regenerating QR code for ${sessionId} (attempt ${currentAttempts + 1}/${this.maxQrRetries})...`);

            // Supprimer l'ancienne session
            this.sessions.delete(sessionId);

            // Recréer une nouvelle session (qui générera un nouveau QR)
            await this.createSession(session.numberId, session.phoneNumber);

            // Notifier le backend qu'un nouveau QR est en cours de génération
            await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
              action: 'qr_regenerating',
              numberId: session.numberId,
              sessionId,
              attempt: currentAttempts + 1,
              maxAttempts: this.maxQrRetries,
              message: `QR code expired. Generating new QR code (attempt ${currentAttempts + 1}/${this.maxQrRetries})`,
              timestamp: Date.now(),
            });
          } else {
            // ❌ NOMBRE MAX DE TENTATIVES ATTEINT
            logger.error(`Max QR retry attempts (${this.maxQrRetries}) reached for ${sessionId}. Giving up.`);

            this.sessions.delete(sessionId);
            this.qrRetryAttempts.delete(session.numberId); // Reset counter

            // Notifier le backend que toutes les tentatives ont échoué
            await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
              action: 'error',
              numberId: session.numberId,
              sessionId,
              error: `QR code generation failed after ${this.maxQrRetries} attempts. Please request a new validation.`,
              timestamp: Date.now(),
            });
          }
        } else {
          // Autres erreurs - tenter la reconnexion
          logger.info(`Attempting to reconnect ${sessionId}...`);
          await this.createSession(session.numberId, session.phoneNumber);
        }
      } else {
        this.sessions.delete(sessionId);

        // ✅ CORRIGÉ : Envoyer disconnected sur worker.events
        await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
          action: 'disconnected',
          numberId: session.numberId,
          sessionId,
          reason: 'Logged out from WhatsApp',
          timestamp: Date.now(),
        });

        // Toujours envoyer le statut de santé
        await rabbitmq.publish(config.rabbitmq.queues.numberHealth, {
          numberId: session.numberId,
          status: 'BANNED',
          reason: 'Logged out from WhatsApp',
        });
      }
    } else if (connection === 'open') {
      logger.info(`Session ${sessionId} connected successfully`);
      session.connected = true;
      session.qrCode = null;

      // ✅ Réinitialiser le compteur de tentatives QR (connexion réussie)
      this.qrRetryAttempts.delete(session.numberId);

      // ✅ CORRIGÉ : Notifier via worker.events
      await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
        action: 'connected',
        numberId: session.numberId,
        sessionId,
        timestamp: Date.now(),
      });

      // Toujours envoyer le statut de santé
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
}

export default new SessionManager();