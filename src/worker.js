// Connect to RabbitMQ
import { config } from './config/config.js';
import logger from './utils/logger.js';
import rabbitmq from '../src/services/rabbitMQService.js';
import sessionManager from './services/sessionManager.js';
import messageHandler from './handles/MessageHandler.js';
import healthHandler from './handles/HealthHandler.js';

class WhatsAppWorker {
  constructor() {
    this.isRunning = false;
    this.isInitialized = false;
    this.rabbitmqConnected = false;
  }

  async start() {
    try {
      logger.info(`Starting WhatsApp Worker: ${config.worker.name} (${config.worker.id})`);
      logger.info(`Environment: ${config.env}`);

      // Connect to RabbitMQ with explicit error handling
      logger.info('Connecting to RabbitMQ...');
      try {
        await rabbitmq.connect();
        this.rabbitmqConnected = true;
        logger.info('RabbitMQ connected');
      } catch (rabbitError) {
        logger.error('Failed to connect to RabbitMQ:', {
          message: rabbitError.message,
          stack: rabbitError.stack,
          code: rabbitError.code
        });
        throw rabbitError;  // Re-throw to be caught by outer catch
      }

      // Start consuming messages
      console.log('\n========================================');
      console.log('🔧 CONFIGURATION DES CONSUMERS');
      console.log('========================================\n');

      try {
        await this.setupConsumers();
        console.log('\n✅ setupConsumers() terminé avec succès\n');
      } catch (consumerError) {
        console.error('\n❌ ERREUR dans setupConsumers():', consumerError);
        throw consumerError;
      }

      // Start health checks
      healthHandler.startHealthChecks();

      // Report worker status periodically
      this.statusInterval = setInterval(async () => {
        await healthHandler.reportWorkerStatus();
      }, 30000); // Every 30 seconds

      this.isRunning = true;
      this.isInitialized = true;
      logger.info('Worker started successfully and ready to process messages');

    } catch (error) {
      logger.error('Failed to start worker:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });

      // Clean up partial initialization
      await this.safeShutdown();
      process.exit(1);
    }
  }

  async setupConsumers() {
    console.log('📍 Début de setupConsumers()...\n');

    // Consumer for message sending
    console.log('1️⃣ Configuration consumer message.send...');
    await rabbitmq.consume(
      config.rabbitmq.queues.messageSend,
      async (data) => {
        await messageHandler.handleSendMessage(data);
      }
    );
    console.log('   ✅ Consumer message.send configuré\n');

    // Consumer for health checks
    console.log('2️⃣ Configuration consumer number.health...');
    await rabbitmq.consume(
      config.rabbitmq.queues.numberHealth,
      async (data) => {
        if (data.action === 'health_check') {
          await healthHandler.handleHealthCheckRequest(data);
        }
      }
    );
    console.log('   ✅ Consumer number.health configuré\n');

    // Consumer for session updates
    console.log('3️⃣ Configuration consumer session.update...');
    console.log('   Queue:', config.rabbitmq.queues.sessionUpdate);
    await rabbitmq.consume(
      config.rabbitmq.queues.sessionUpdate,
      async (data) => {
        console.log('\n🔔 CONSUMER APPELÉ - Nouveau message reçu!');
        await this.handleSessionUpdate(data);
      }
    );
    console.log('   ✅ Consumer session.update configuré\n');

    console.log('========================================');
    console.log('✅ TOUS LES CONSUMERS CONFIGURÉS');
    console.log('========================================');
    console.log('En attente de messages sur:');
    console.log('  - ', config.rabbitmq.queues.messageSend);
    console.log('  - ', config.rabbitmq.queues.numberHealth);
    console.log('  - ', config.rabbitmq.queues.sessionUpdate);
    console.log('========================================\n');

    logger.info('All message consumers set up successfully');
  }

  async handleSessionUpdate(message) {
    // ========================================
    // AFFICHAGE COMPLET DU MESSAGE REÇU
    // ========================================
    console.log('\n========================================');
    console.log('📨 MESSAGE REÇU DE RABBITMQ');
    console.log('========================================');
    console.log('Type du message:', typeof message);
    console.log('Message brut:', message);
    console.log('========================================\n');

    // ✅ DÉSÉRIALISATION : Si le message est une chaîne, le parser
    let parsedMessage = message;
    if (typeof message === 'string') {
      console.log('⚠️ Message reçu en tant que STRING, parsing...');
      try {
        parsedMessage = JSON.parse(message);
        console.log('✅ Message parsé:', parsedMessage);
      } catch (parseError) {
        logger.error('Failed to parse message:', parseError);
        console.error('Message invalide:', message);
        return;
      }
    }

    console.log('Message final:', JSON.stringify(parsedMessage, null, 2));
    logger.info('[SESSION UPDATE] Received message:', JSON.stringify(parsedMessage));

    const { action, data: messageData } = parsedMessage;

    console.log('Action extraite:', action);
    console.log('Data extraite:', messageData);

    // ✅ IGNORER LES MESSAGES worker_status (envoyés par les workers eux-mêmes)
    if (action === 'worker_status') {
      console.log('ℹ️ Message worker_status ignoré (message de statut interne)');
      logger.debug('Received worker_status message, ignoring');
      return;
    }

    // Extraire les données depuis l'objet 'data' envoyé par le backend
    const numberId = messageData?.numberId;
    const phoneNumber = messageData?.phoneNumber;
    const workerId = messageData?.workerId;

    console.log('numberId:', numberId);
    console.log('phoneNumber:', phoneNumber);
    console.log('workerId:', workerId);
    console.log('Mon worker ID:', config.worker.id);

    // ✅ FILTRAGE PAR WORKER ID
    // Si le message contient un workerId et qu'il ne correspond pas au nôtre, on l'ignore
    // if (workerId && workerId !== config.worker.id) {
    //   console.log(`❌ Message ignoré - Pour worker ${workerId}, je suis ${config.worker.id}`);
    //   logger.debug(`Ignoring message for worker ${workerId} (I am ${config.worker.id})`);
    //   return;
    // }

    console.log(`✅ Message accepté - Action: ${action}, Number: ${numberId}`);
    logger.info(`Session update: ${action} for number ${numberId} (worker: ${workerId || 'any'})`);

    switch (action) {
      case 'create':
        if (!numberId || !phoneNumber) {
          logger.error('Missing numberId or phoneNumber in create action');
          console.error('❌ Données manquantes pour create:', { numberId, phoneNumber });
          return;
        }
        console.log(`🔄 Création de session pour numéro ${numberId}...`);
        await sessionManager.createSession(numberId, phoneNumber);
        console.log(`✅ Session créée pour numéro ${numberId}`);
        break;

      case 'close':
        if (!numberId) {
          logger.error('Missing numberId in close action');
          console.error('❌ numberId manquant pour close');
          return;
        }
        console.log(`🔄 Fermeture de session pour numéro ${numberId}...`);
        const session = sessionManager.getSession(numberId);
        if (session) {
          await sessionManager.closeSession(session.sessionId);
          console.log(`✅ Session fermée pour numéro ${numberId}`);
        } else {
          logger.warn(`Session not found for number ${numberId}`);
          console.warn(`⚠️ Session non trouvée pour numéro ${numberId}`);
        }
        break;

      case 'reconnect':
        if (!numberId || !phoneNumber) {
          logger.error('Missing numberId or phoneNumber in reconnect action');
          console.error('❌ Données manquantes pour reconnect:', { numberId, phoneNumber });
          return;
        }
        console.log(`🔄 Reconnexion de session pour numéro ${numberId}...`);
        const existingSession = sessionManager.getSession(numberId);
        if (existingSession) {
          await sessionManager.closeSession(existingSession.sessionId);
          console.log(`✅ Ancienne session fermée pour numéro ${numberId}`);
        }
        await sessionManager.createSession(numberId, phoneNumber);
        console.log(`✅ Nouvelle session créée pour numéro ${numberId}`);
        break;

      case 'regenerate_qr':
        if (!numberId || !phoneNumber) {
          logger.error('Missing numberId or phoneNumber in regenerate_qr action');
          console.error('❌ Données manquantes pour regenerate_qr:', { numberId, phoneNumber });
          return;
        }

        console.log(`🔄 Régénération manuelle du QR demandée pour numéro ${numberId}...`);
        logger.info(`Manual QR regeneration requested for number ${numberId}`);

        // Vérifier si une session existe
        const currentSession = sessionManager.getSession(numberId);

        if (currentSession) {
          // Vérifier si déjà connecté
          if (currentSession.connected) {
            console.log(`✅ Session déjà connectée pour numéro ${numberId} - Pas besoin de QR`);
            logger.info(`Session already connected for number ${numberId}`);

            // Notifier le backend que la session est déjà connectée
            await rabbitmq.publish(config.rabbitmq.queues.workerEvents, {
              action: 'connected',
              numberId: numberId,
              sessionId: currentSession.sessionId,
              message: 'Session already connected. No QR needed.',
              timestamp: Date.now(),
            });
            return;
          }

          // Session existe mais pas connectée → Fermer et recréer
          console.log(`🔄 Fermeture de la session existante pour régénération du QR...`);
          await sessionManager.closeSession(currentSession.sessionId);
          console.log(`✅ Ancienne session fermée`);
        }

        // Réinitialiser le compteur de tentatives QR pour ce numéro
        sessionManager.resetQrRetries(numberId);
        console.log(`🔄 Compteur de tentatives QR réinitialisé pour numéro ${numberId}`);

        // Créer une nouvelle session (qui générera un nouveau QR)
        console.log(`🔄 Création d'une nouvelle session pour générer un nouveau QR...`);
        await sessionManager.createSession(numberId, phoneNumber);
        console.log(`✅ Nouvelle session créée - Nouveau QR en cours de génération pour numéro ${numberId}`);

        logger.info(`QR regeneration initiated for number ${numberId}`);
        break;

      default:
        logger.warn(`Unknown session action: ${action}`);
        console.warn(`⚠️ Action inconnue: ${action}`);
    }

    console.log('========================================\n');
  }

  async safeShutdown() {
    logger.info('Shutting down worker...');

    this.isRunning = false;

    try {
      // Stop status reporting interval
      if (this.statusInterval) {
        clearInterval(this.statusInterval);
      }

      // Stop health checks only if initialized
      if (this.isInitialized) {
        healthHandler.stopHealthChecks();
      }

      // Close all WhatsApp sessions
      logger.info('Closing all sessions...');
      await sessionManager.closeAllSessions();

      // Close RabbitMQ connection only if it was connected
      if (this.rabbitmqConnected) {
        logger.info('Closing RabbitMQ connection...');
        await rabbitmq.close();
      }

      logger.info('Worker shut down successfully');
    } catch (error) {
      logger.error('Error during shutdown:', {
        message: error.message,
        stack: error.stack
      });
    }
  }

  async shutdown() {
    await this.safeShutdown();
    process.exit(0);
  }
}

// Create worker instance
const worker = new WhatsAppWorker();

// Start the worker
worker.start().catch((error) => {
  logger.error('Fatal error starting worker:', {
    message: error.message,
    stack: error.stack
  });
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal');
  await worker.shutdown();
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal');
  await worker.shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection:', {
    reason: reason,
    promise: promise,
    stack: reason?.stack
  });
  // Don't call shutdown here - let the app continue
});

process.on('uncaughtException', async (error) => {
  // Force l'affichage complet de l'erreur
  console.error('\n=== UNCAUGHT EXCEPTION ===');
  console.error('Type:', typeof error);
  console.error('Constructor:', error?.constructor?.name);
  console.error('Error object:', error);

  // Essayez différentes façons d'extraire l'info
  if (error) {
    console.error('Message:', error.message);
    console.error('Name:', error.name);
    console.error('Code:', error.code);
    console.error('Stack:', error.stack);

    // Pour les erreurs AMQP
    console.error('Reply Code:', error.replyCode);
    console.error('Reply Text:', error.replyText);

    // Dump complet
    console.error('Full error keys:', Object.keys(error));
    console.error('Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
  }
  console.error('========================\n');

  logger.error('Uncaught Exception:', {
    message: error?.message,
    stack: error?.stack,
    name: error?.name,
    code: error?.code,
    replyCode: error?.replyCode,
    replyText: error?.replyText
  });

  // Only shutdown if worker is initialized
  if (worker.isInitialized) {
    await worker.safeShutdown();
  }

  process.exit(1);
});

export default worker;